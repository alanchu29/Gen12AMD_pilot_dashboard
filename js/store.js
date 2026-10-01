/* App state: dataset, UI prefs, undo/redo, local persistence, schedule cache. */
(function () {
  const E = window.Engine;
  const LS_DATA = "npiGantt.data.v1";
  const LS_UI = "npiGantt.ui.v1";
  const LS_DIRTY = "npiGantt.dirty.v1";
  const UNDO_LIMIT = 100;

  const lsGet = (k) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  const DEFAULT_UI = {
    selectedId: null,
    search: "",
    filters: { gen: [], site: [], phase: [], sku: [] },
    showHidden: false,
    sort: "start", // L10 Build date
    uiRev: 3, // bump to migrate saved UI settings when a default changes (see init)
    zoom: "week",
    colorBy: "owner",
    showDeps: false,
    showBaseline: true,
    collapsed: {},
    theme: "dark",
    tableOpen: true,
    focusRoles: ["STE", "MTE"], // tasks whose LEAD contains these get highlighted
    highlight: true,
    onlyFocus: false,
    pfView: "group", // portfolio: "group" merges 1st+2nd builds, "sheet" lists every Excel sheet
    pfExpanded: {}, // group id -> member rows shown in the portfolio
    pfFullRange: false, // portfolio timeline: false = start 2 months before today
    tableTab: {}, // group id -> sheet id edited in the raw table
  };

  const Store = {
    data: null,
    ui: clone(DEFAULT_UI),
    dirty: new Set(), // pfam ids changed since last cloud save
    undoStack: [],
    redoStack: [],
    listeners: new Set(),
    cache: new Map(),
    saveError: false,

    init() {
      const saved = lsGet(LS_DATA);
      this.data = saved && saved.schema === 1 && saved.pfams ? saved : clone(window.NPI_SEED);
      const savedUi = lsGet(LS_UI) || {};
      this.ui = Object.assign(clone(DEFAULT_UI), savedUi);
      if ((savedUi.uiRev || 1) < 2) this.ui.sort = DEFAULT_UI.sort; // rev 2: default sort became L10 Build
      if ((savedUi.uiRev || 1) < 3 && this.ui.theme === "auto") this.ui.theme = DEFAULT_UI.theme; // rev 3: default theme became dark
      this.ui.uiRev = DEFAULT_UI.uiRev;
      this.ui.filters = Object.assign(clone(DEFAULT_UI.filters), this.ui.filters || {});
      this.dirty = new Set(lsGet(LS_DIRTY) || []);
      if (this.ui.selectedId && !this.pfam(this.ui.selectedId)) this.ui.selectedId = null;
    },

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    emit(reason, detail) {
      for (const fn of this.listeners) fn(reason, detail);
    },

    persist: null, // assigned below (debounced)
    persistUi() {
      lsSet(LS_UI, this.ui);
    },
    setUi(patch) {
      Object.assign(this.ui, patch);
      this.persistUi();
      this.emit("ui", patch);
    },

    pfam(id) {
      return this.data.pfams.find((p) => p.id === id) || null;
    },
    selected() {
      return this.ui.selectedId ? this.pfam(this.ui.selectedId) : null;
    },
    task(pfam, id) {
      return pfam.tasks.find((t) => t.id === id) || null;
    },

    /** Memoized schedule per PFAM; invalidated by bumping pfam._rev. */
    sched(pfam) {
      const hit = this.cache.get(pfam.id);
      // Undo swaps in a new object whose _rev can collide with the cached one, so check identity too.
      if (hit && hit.obj === pfam && hit.rev === pfam._rev && hit.cals === this.data.calendars) return hit.res;
      const res = E.schedule(pfam, this.data.calendars);
      res.wbs = E.wbsMap(pfam);
      this.cache.set(pfam.id, { obj: pfam, rev: pfam._rev, cals: this.data.calendars, res });
      return res;
    },

    // ---- mutations -------------------------------------------------------
    /** Run fn(pfam) as one undoable edit. */
    edit(pfamId, label, fn) {
      const p = this.pfam(pfamId);
      if (!p) return;
      const before = JSON.stringify(p);
      const result = fn(p);
      if (result === false) return;
      if (JSON.stringify(p) === before) return;
      // First web edit of an Excel sheet: remember the imported version, so a later Excel import
      // can tell "edited on the web" apart and "還原為 Excel 版本" restores the latest import.
      if (!p._xl && this.fromExcel(p)) {
        const orig = JSON.parse(before);
        delete orig._rev;
        p._xl = orig;
      }
      this.undoStack.push({ pfamId, before, label });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.touch(p);
    },

    touch(p) {
      p._rev = (p._rev || 0) + 1;
      p.updatedAt = new Date().toISOString();
      this.dirty.add(p.id);
      lsSet(LS_DIRTY, [...this.dirty]);
      this.persist();
      this.emit("data", { pfamId: p.id });
    },

    swapSnapshot(from, to) {
      const entry = from.pop();
      if (!entry) return;
      const i = this.data.pfams.findIndex((p) => p.id === entry.pfamId);
      if (i < 0) return;
      to.push({ pfamId: entry.pfamId, before: JSON.stringify(this.data.pfams[i]), label: entry.label });
      const restored = JSON.parse(entry.before);
      restored.version = this.data.pfams[i].version; // keep server version for conflict checks
      this.data.pfams[i] = restored;
      const showing = window.App && App.isShowing ? App.isShowing(entry.pfamId) : this.ui.selectedId === entry.pfamId;
      if (!showing) this.setUi({ selectedId: entry.pfamId });
      this.touch(restored);
      return entry.label;
    },
    undo() {
      return this.swapSnapshot(this.undoStack, this.redoStack);
    },
    redo() {
      return this.swapSnapshot(this.redoStack, this.undoStack);
    },

    updateTask(pfamId, taskId, patch, label) {
      this.edit(pfamId, label || "編輯任務", (p) => {
        const t = this.task(p, taskId);
        if (!t) return false;
        Object.assign(t, patch);
      });
    },

    newTask(type) {
      if (type === "section") return { id: U.uid("s"), type: "section", name: "新區段" };
      return {
        id: U.uid("t"), type: "task", name: "新任務", lead: "",
        startMode: "manual", pred: null, lag: 1, start: null,
        workdays: 1, endMode: "dur", endAdj: -1, end: null,
        startCal: "site", endCal: "site", pct: 0, code: "", notes: "",
      };
    },

    insertTask(pfamId, afterId, type) {
      let created = null;
      this.edit(pfamId, type === "section" ? "新增區段" : "新增任務", (p) => {
        const t = this.newTask(type);
        const i = afterId ? p.tasks.findIndex((x) => x.id === afterId) : p.tasks.length - 1;
        // A new task after X depends on X by default, like the workbook's chained rows.
        const prev = p.tasks[i];
        if (type !== "section" && prev && prev.type === "task") {
          t.startMode = "dep";
          t.pred = prev.id;
          t.startCal = t.endCal = "site";
        } else if (type !== "section") {
          t.start = E.fromDay(E.toDay(new Date().toISOString().slice(0, 10)));
        }
        p.tasks.splice(i + 1, 0, t);
        created = t;
      });
      return created;
    },

    deleteTask(pfamId, taskId) {
      this.edit(pfamId, "刪除", (p) => {
        const i = p.tasks.findIndex((x) => x.id === taskId);
        if (i < 0) return false;
        const [gone] = p.tasks.splice(i, 1);
        // Tasks that depended on the removed one keep their date: pin them as manual.
        const sched = E.schedule({ ...p, tasks: [...p.tasks, gone] }, this.data.calendars);
        for (const t of p.tasks) {
          if (t.pred === taskId) {
            const r = sched.rows.get(t.id);
            t.startMode = "manual";
            t.pred = null;
            t.start = r && r.start != null ? E.fromDay(r.start) : null;
          }
        }
      });
    },

    moveTask(pfamId, taskId, dir) {
      this.edit(pfamId, "移動", (p) => {
        const i = p.tasks.findIndex((x) => x.id === taskId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.tasks.length) return false;
        [p.tasks[i], p.tasks[j]] = [p.tasks[j], p.tasks[i]];
      });
    },

    updatePfam(pfamId, patch, label) {
      this.edit(pfamId, label || "編輯專案資訊", (p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (k === "meta") p.meta = Object.assign({}, p.meta, v);
          else p[k] = v;
        }
      });
    },

    /** Freeze current computed dates as the new baseline. */
    rebaseline(pfamId) {
      const p = this.pfam(pfamId);
      const s = this.sched(p);
      this.edit(pfamId, "設為新基準", (pp) => {
        for (const t of pp.tasks) {
          if (t.type !== "task") continue;
          const r = s.rows.get(t.id);
          t.base = { start: E.fromDay(r.start), end: E.fromDay(r.end) };
        }
        pp.baselineAt = new Date().toISOString();
        delete pp.baselineLabel;
      });
    },

    /** Restore one PFAM to its imported Excel state. */
    revertPfam(pfamId) {
      const cur = this.pfam(pfamId);
      const src = cur && this.excelRef(cur);
      if (!src) return false;
      this.edit(pfamId, "還原為 Excel 版本", (p) => {
        const keep = { id: p.id, version: p.version, group: p.group, _xl: clone(src) };
        for (const k of Object.keys(p)) delete p[k];
        Object.assign(p, clone(src), keep);
      });
      return true;
    },

    // ---- Excel identity -----------------------------------------------------
    /** Sheets that came from Excel (vs. created/duplicated on the web). */
    fromExcel(p) {
      return !!(p.xlSheet || /^p\d{3}$/.test(p.id));
    },
    /** Exact Excel sheet name (identity when re-importing). */
    xlName(p) {
      if (p.xlSheet) return p.xlSheet;
      if (!/^p\d{3}$/.test(p.id)) return null;
      // Data saved before xlSheet existed: take the exact name from the bundled seed.
      const s = window.NPI_SEED && window.NPI_SEED.pfams.find((x) => x.id === p.id && x.sheet === p.sheet);
      return s && s.xlSheet ? s.xlSheet : p.sheet;
    },
    /** The sheet as last imported from Excel (null for web-only sheets). */
    excelRef(p) {
      if (p._xl) return p._xl;
      if (!this.fromExcel(p)) return null;
      // Data still from the bundled seed: that is the imported version.
      const seed = window.NPI_SEED;
      if (seed && this.data.source && seed.source && this.data.source.file === seed.source.file && !this.data.source.uploaded) {
        return seed.pfams.find((x) => x.id === p.id) || p;
      }
      return p;
    },
    /**
     * Schedule content only (ignores ids, baselines, sync bookkeeping). Key order and empty values are
     * normalised: the cloud returns fields in column order and fills in blanks/defaults.
     */
    canon(p) {
      const tasks = (p.tasks || []).map((t) => {
        const o = {};
        for (const k of Object.keys(t).sort()) {
          const v = t[k];
          if (k === "base" || v === "" || v === null || v === undefined || v === false) continue;
          o[k] = v;
        }
        if (t.type === "task") for (const k of ["lag", "endAdj", "pct"]) o[k] = t[k] || 0;
        return o;
      });
      const meta = {};
      for (const k of Object.keys(p.meta || {}).sort()) if (p.meta[k]) meta[k] = p.meta[k];
      const s = (v) => v || "";
      return JSON.stringify({ sheet: s(p.sheet), title: s(p.title), site: s(p.site), calendar: s(p.calendar), hidden: !!p.hidden, meta, assumptions: s(p.assumptions), tasks });
    },
    webEdited(p) {
      const ref = this.excelRef(p);
      return !!ref && ref !== p && this.canon(ref) !== this.canon(p);
    },

    duplicatePfam(pfamId) {
      const src = this.pfam(pfamId);
      const copy = clone(src);
      copy.id = U.uid("p");
      copy.sheet = src.sheet + " (副本)";
      copy.hidden = false;
      copy.version = 0;
      copy.order = src.order + 0.5;
      // A copy is a web-only sheet: it must not pair with the Excel sheet on the next import.
      delete copy.xlSheet;
      delete copy._xl;
      delete copy.group;
      const idMap = new Map(copy.tasks.map((t) => [t.id, U.uid("t")]));
      for (const t of copy.tasks) {
        t.id = idMap.get(t.id);
        if (t.pred) t.pred = idMap.get(t.pred) || null;
      }
      const i = this.data.pfams.indexOf(src);
      this.data.pfams.splice(i + 1, 0, copy);
      this.renumberOrder();
      this.touch(copy);
      return copy;
    },

    deletePfam(pfamId) {
      const i = this.data.pfams.findIndex((p) => p.id === pfamId);
      if (i < 0) return;
      this.data.pfams.splice(i, 1);
      (this.data.deleted = this.data.deleted || []).push(pfamId);
      this.dirty.delete(pfamId);
      this.undoStack = this.undoStack.filter((u) => u.pfamId !== pfamId);
      this.redoStack = this.redoStack.filter((u) => u.pfamId !== pfamId);
      if (this.ui.selectedId === pfamId) this.ui.selectedId = null;
      this.persist();
      this.persistUi();
      this.emit("data", { deleted: pfamId });
    },

    renumberOrder() {
      this.data.pfams.forEach((p, i) => (p.order = i + 1));
    },

    setCalendars(calendars) {
      this.data.calendars = calendars;
      this.data.calendarsDirty = true;
      this.cache.clear();
      this.persist();
      this.emit("data", { calendars: true });
    },

    /** Replace the whole dataset (JSON import, cloud load, reset). */
    replaceData(data, { keepDirty = false } = {}) {
      this.data = data;
      this.cache.clear();
      this.undoStack = [];
      this.redoStack = [];
      if (!keepDirty) {
        this.dirty.clear();
        lsSet(LS_DIRTY, []);
      }
      if (this.ui.selectedId && !this.pfam(this.ui.selectedId)) this.ui.selectedId = null;
      this.persist.now();
      this.emit("data", { replaced: true });
    },

    resetToSeed() {
      this.replaceData(clone(window.NPI_SEED));
    },

    exportJson() {
      const out = clone(this.data);
      for (const p of out.pfams) delete p._rev;
      out.exportedAt = new Date().toISOString();
      return out;
    },

    markClean(ids) {
      for (const id of ids) this.dirty.delete(id);
      lsSet(LS_DIRTY, [...this.dirty]);
    },
  };

  const writeData = () => {
    const ok = lsSet(LS_DATA, Store.data);
    if (ok === Store.saveError) {
      Store.saveError = !ok;
      Store.emit("saveState", { ok });
    }
  };
  Store.persist = U.debounce(writeData, 400);
  Store.persist.now = writeData;

  window.Store = Store;
})();
