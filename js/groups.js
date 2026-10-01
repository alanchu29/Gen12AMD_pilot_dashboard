/*
 * PFAM groups: the 1st and 2nd build sheets of the same PFAM, shown together.
 * Groups are derived (never stored), so each sheet keeps its own data and Excel mapping.
 * A sheet can override its group with pfam.group ("-" = never merge).
 */
(function () {
  const E = window.Engine;
  const BUILD_ORDER = { "1st": 1, "2nd": 2 };

  function variantOf(sheet) {
    if (/lanai/i.test(sheet)) return "Lanai";
    const m = sheet.match(/\((PV\d+\s*Op\d+)\)/i);
    return m ? m[1].replace(/\s+/, " ").replace(/op/i, "Op") : "";
  }

  /** Automatic group key: same Gen + SKU + variant, 1st/2nd builds only. */
  function autoKey(p) {
    const t = U.tags(p);
    if (!BUILD_ORDER[t.phase] || !t.sku) return null;
    return [t.gen, t.sku, variantOf(p.sheet)].join("|");
  }

  function keyOf(p) {
    if (p.group === "-") return null;
    return p.group ? "manual|" + p.group : autoKey(p);
  }

  function nameOf(key, members) {
    if (key.startsWith("manual|")) return key.slice(7);
    const [gen, sku, variant] = key.split("|");
    return `Gen ${gen} ${sku}${variant ? " · " + variant : ""}`;
  }

  const Groups = {
    autoKey,

    /** Name for a sheet outside any group, in the group style ("Gen 12.1 GP-HL · Pre GA"); the sheet name when the tags can't tell. */
    label(p) {
      const t = U.tags(p);
      if (!t.sku || t.phase === "其他") return p.sheet;
      const v = variantOf(p.sheet);
      return `Gen ${t.gen} ${t.sku}${v ? " · " + v : ""} · ${t.phase}`;
    },

    /**
     * Top-level entries for the portfolio in sheet order: { kind: "group", id, name, members:[{p, build}] }
     * or { kind: "pfam", p }. Archived (hidden) sheets never merge.
     */
    entries(showHidden) {
      const byKey = new Map();
      for (const p of Store.data.pfams) {
        if (p.hidden) continue;
        const k = keyOf(p);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(p);
      }
      const groupOf = new Map();
      for (const [k, list] of byKey) {
        if (list.length < 2) continue;
        // One sheet per build; extra sheets for the same build stay standalone.
        const seen = new Set();
        const members = [];
        for (const p of list) {
          const b = U.tags(p).phase;
          const build = BUILD_ORDER[b] ? b : p.sheet;
          if (seen.has(build)) continue;
          seen.add(build);
          members.push({ p, build });
        }
        if (members.length < 2) continue;
        members.sort((a, b) => (BUILD_ORDER[a.build] || 9) - (BUILD_ORDER[b.build] || 9));
        const g = { kind: "group", id: "g:" + k, key: k, name: nameOf(k, members), members };
        for (const m of members) groupOf.set(m.p.id, g);
      }
      const out = [];
      const emitted = new Set();
      for (const p of Store.data.pfams) {
        if (p.hidden && !showHidden) continue;
        const g = groupOf.get(p.id);
        if (g) {
          if (!emitted.has(g.id)) {
            emitted.add(g.id);
            out.push(g);
          }
        } else out.push({ kind: "pfam", p });
      }
      return out;
    },

    find(id) {
      return this.entries(true).find((e) => e.kind === "group" && e.id === id) || null;
    },

    /** Which group (if any) a sheet currently belongs to. */
    groupOfPfam(pfamId) {
      return this.entries(true).find((e) => e.kind === "group" && e.members.some((m) => m.p.id === pfamId)) || null;
    },

    /**
     * Index of "name|start|end" -> set of sheet ids, over visible sheets.
     * Used to spot 2nd-build sections that were copied from another sheet.
     */
    copyIndex() {
      const idx = new Map();
      for (const p of Store.data.pfams) {
        if (p.hidden) continue;
        const s = Store.sched(p);
        for (const t of p.tasks) {
          if (t.type !== "task") continue;
          const r = s.rows.get(t.id);
          if (!r || r.start == null) continue;
          const k = `${t.name.trim().toLowerCase()}|${r.start}|${r.end}`;
          if (!idx.has(k)) idx.set(k, new Set());
          idx.get(k).add(p.id);
        }
      }
      return idx;
    },

    /**
     * Build a synthetic PFAM for the Gantt: one "lane" row per build, then that sheet's rows.
     * Ids are prefixed "<pfamId>:" so builds never collide. In 2nd+ builds every section except
     * the volume build is marked inherited (collapsed by default: "same as 1st").
     */
    merged(g) {
      const idx = this.copyIndex();
      const tasks = [];
      const rows = new Map();
      const wbs = new Map();
      const defaults = new Set();
      const perBuild = [];
      let min = Infinity;
      let max = -Infinity;

      g.members.forEach((m, mi) => {
        const p = m.p;
        const s = Store.sched(p);
        const pre = p.id + ":";
        const laneId = pre + "lane";
        const tg = U.tags(p);
        tasks.push({ id: laneId, type: "lane", name: p.sheet, build: m.build, site: tg.site, _pfamId: p.id });
        let inherited = false;
        let lmin = Infinity;
        let lmax = -Infinity;
        let secTasks = null;
        const secStats = [];
        for (const t of p.tasks) {
          const id = pre + t.id;
          if (t.type === "section") {
            inherited = mi > 0 && !/volume/i.test(t.name);
            secTasks = { id, inherited, total: 0, copied: 0 };
            secStats.push(secTasks);
            if (inherited) defaults.add(id);
            tasks.push({ ...t, id, _pfamId: p.id, _build: m.build, _inherited: inherited });
          } else {
            tasks.push({ ...t, id, pred: t.pred ? pre + t.pred : null, _pfamId: p.id, _build: m.build, _inherited: inherited });
            const r = s.rows.get(t.id);
            if (secTasks && r && r.start != null) {
              secTasks.total++;
              const hits = idx.get(`${t.name.trim().toLowerCase()}|${r.start}|${r.end}`);
              if (hits && [...hits].some((pid) => pid !== p.id)) secTasks.copied++;
            }
            if (!inherited && r) {
              for (const v of [r.start, r.end]) {
                if (v == null) continue;
                lmin = Math.min(lmin, v);
                lmax = Math.max(lmax, v);
              }
            }
          }
          rows.set(id, s.rows.get(t.id));
          wbs.set(id, s.wbs.get(t.id));
        }
        for (const st of secStats) {
          const t = tasks.find((x) => x.id === st.id);
          t._copied = st.copied;
          t._total = st.total;
        }
        const span = { start: isFinite(lmin) ? lmin : null, end: isFinite(lmax) ? lmax : null };
        rows.set(laneId, { lane: true, start: span.start, end: span.end });
        if (span.start != null) {
          min = Math.min(min, span.start);
          max = Math.max(max, span.end);
        }
        perBuild.push({ build: m.build, p, sched: s, key: U.keyDates(p, s), span });
      });

      const first = g.members[0].p;
      const pfam = { id: g.id, sheet: g.name, title: "", calendar: first.calendar, tasks, merged: true };
      const sched = { rows, wbs, span: { start: isFinite(min) ? min : null, end: isFinite(max) ? max : null }, milestones: {} };
      return { pfam, sched, defaults, perBuild };
    },

    /** Key dates of a group for the portfolio: 1st build's L10/ETD, last build's dock. */
    summary(g) {
      const m = this.merged(g);
      const pb = m.perBuild;
      const firstKey = pb[0].key;
      const last = pb[pb.length - 1];
      const key = { build: firstKey.build, etd: firstKey.etd, dock: last.key.dock, dockDelta: last.key.dockDelta };
      return { ...m, key };
    },
  };

  window.Groups = Groups;
})();
