/*
 * "匯入新版 Excel": read an updated workbook in the browser, preview what changes, then apply.
 * Rules (agreed with the user):
 *   - Excel is the source of truth; sheets edited on the web are asked about one by one.
 *   - The previous version's dates become the baseline, so ▲/▼ show what moved since the last Excel.
 * Sheets are matched by their Excel sheet name (xlSheet); renamed sheets can be paired by hand.
 */
(function () {
  const E = window.Engine;
  const $ = U.$;
  let xlsxLoading = null;
  let plan = null;
  let undoSnapshot = null;

  /** SheetJS is ~880 KB: load it only when someone imports. Works from file:// too. */
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
      xlsxLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "js/vendor/xlsx.full.min.js";
        s.onload = () => resolve(window.XLSX);
        s.onerror = () => {
          xlsxLoading = null;
          reject(new Error("無法載入 js/vendor/xlsx.full.min.js"));
        };
        document.head.appendChild(s);
      });
    }
    return xlsxLoading;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  /** "12.0_DV 1st 10rack_LZ_S(5)" -> "12.0_DV 1st 10rack_LZ_S" (drop a trailing version number). */
  const baseName = (s) => String(s).replace(/\s*\(\d+(?:\.\d+)*\)\s*$/, "").trim();

  function dockOf(p, cals) {
    const s = cals ? E.schedule(p, cals) : Store.sched(p);
    const k = U.keyDates(p, s);
    return k.dock ? k.dock.start : null;
  }

  /** Map new tasks to old ones: same WBS + name, else a unique same-name task. */
  function matchTasks(oldP, newP) {
    const ow = E.wbsMap(oldP);
    const nw = E.wbsMap(newP);
    const byKey = new Map();
    const byName = new Map();
    for (const t of oldP.tasks) {
      if (t.type !== "task") continue;
      byKey.set(ow.get(t.id) + "|" + normName(t.name), t);
      const n = normName(t.name);
      byName.set(n, byName.has(n) ? null : t);
    }
    const out = new Map();
    for (const t of newP.tasks) {
      if (t.type !== "task") continue;
      const hit = byKey.get(nw.get(t.id) + "|" + normName(t.name)) || byName.get(normName(t.name));
      if (hit) out.set(t.id, hit);
    }
    return out;
  }

  /** Dates of the previous version per old task: its Excel base if edited on the web, else what it computes to. */
  function prevDates(oldP) {
    const edited = Store.webEdited(oldP);
    const s = Store.sched(oldP);
    const out = new Map();
    for (const t of oldP.tasks) {
      if (t.type !== "task") continue;
      if (edited) out.set(t.id, t.base ? { start: t.base.start, end: t.base.end } : null);
      else {
        const r = s.rows.get(t.id) || {};
        out.set(t.id, { start: E.fromDay(r.start), end: E.fromDay(r.end) });
      }
    }
    return out;
  }

  function countMoved(oldP, newP, cals) {
    const m = matchTasks(oldP, newP);
    const prev = prevDates(oldP);
    const ns = E.schedule(newP, cals);
    let moved = 0;
    for (const [nid, ot] of m) {
      const p = prev.get(ot.id);
      const r = ns.rows.get(nid) || {};
      if (p && (p.start !== E.fromDay(r.start) || p.end !== E.fromDay(r.end))) moved++;
    }
    const added = newP.tasks.filter((t) => t.type === "task").length - m.size;
    return { moved, added };
  }

  // ---------------------------------------------------------------- plan
  function buildPlan(incoming, fileName) {
    const cur = Store.data.pfams;
    const byXl = new Map();
    for (const p of cur) {
      const k = Store.xlName(p);
      if (k) byXl.set(k, p);
    }
    const rows = [];
    const matchedOld = new Set();
    for (const np of incoming.pfams) {
      const old = byXl.get(np.xlSheet);
      if (!old) {
        rows.push({ kind: "new", np, map: "" });
        continue;
      }
      matchedOld.add(old.id);
      rows.push(pairRow(old, np, incoming.calendars));
    }
    for (const old of cur) {
      if (!Store.fromExcel(old) || matchedOld.has(old.id)) continue;
      rows.push({ kind: "gone", old, edited: Store.webEdited(old), action: Store.webEdited(old) ? "keep" : "remove" });
    }
    // Suggest rename pairs: one vanished + one new sheet sharing the same name without the version suffix.
    const gone = rows.filter((r) => r.kind === "gone");
    const fresh = rows.filter((r) => r.kind === "new");
    for (const r of fresh) {
      const b = baseName(r.np.xlSheet);
      const g = gone.filter((x) => baseName(Store.xlName(x.old)) === b);
      const f = fresh.filter((x) => baseName(x.np.xlSheet) === b);
      if (g.length === 1 && f.length === 1) r.map = g[0].old.id;
    }
    const webOnly = cur.filter((p) => !Store.fromExcel(p));
    return { incoming, fileName, rows, webOnly, calDiff: calendarDiff(Store.data.calendars, incoming.calendars) };
  }

  function pairRow(old, np, cals) {
    const ref = Store.excelRef(old) || old;
    const excelChanged = Store.canon(ref) !== Store.canon(np);
    const edited = Store.webEdited(old);
    let kind = "same";
    if (excelChanged && edited) kind = "conflict";
    else if (excelChanged) kind = "update";
    else if (edited) kind = "keepweb";
    const row = { kind, old, np, edited, action: kind === "conflict" ? "excel" : undefined };
    if (excelChanged) {
      row.dockOld = dockOf(old);
      row.dockNew = dockOf(np, cals);
      Object.assign(row, countMoved(old, np, cals));
    }
    return row;
  }

  function calendarDiff(a, b) {
    const out = [];
    for (const site of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const x = new Set(((a[site] || {}).holidays || []).map((h) => h.date));
      const y = new Set(((b[site] || {}).holidays || []).map((h) => h.date));
      const add = [...y].filter((d) => !x.has(d)).length;
      const del = [...x].filter((d) => !y.has(d)).length;
      if (add || del) out.push({ site, add, del });
    }
    return out;
  }

  // ---------------------------------------------------------------- dialog
  function dockCell(r) {
    if (r.dockOld == null && r.dockNew == null) return "—";
    const d = r.dockOld != null && r.dockNew != null ? r.dockNew - r.dockOld : null;
    const delta = d ? `<b class="${d > 0 ? "late" : "early"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}d</b>` : d === 0 ? `<span class="muted">不變</span>` : "";
    return `${U.fmt(r.dockOld, "yy") || "—"} → ${U.fmt(r.dockNew, "yy") || "—"} ${delta}`;
  }
  const nameCell = (p, extra) => `<span class="imp-name" title="${U.esc(p.sheet)}">${U.esc(p.sheet)}</span>${p.hidden ? `<span class="tag ghost">隱藏</span>` : ""}${extra || ""}`;
  const movedCell = (r) => (r.moved || r.added ? `${r.moved ? `${r.moved} 個任務日期變動` : ""}${r.moved && r.added ? "・" : ""}${r.added ? `${r.added} 個新任務` : ""}` : `<span class="muted">內容調整</span>`);

  function render() {
    const d = $("#dlgImport");
    const rows = plan.rows;
    const by = (k) => rows.filter((r) => r.kind === k);
    const conflicts = by("conflict");
    const updates = by("update");
    const fresh = by("new");
    const gone = by("gone");
    const keepweb = by("keepweb");
    const same = by("same");
    const goneOpts = gone.map((g) => g.old);

    const sec = (title, note, body, cls) => (body ? `<section class="imp-sec ${cls || ""}"><h4>${title}${note ? `<span class="muted">${note}</span>` : ""}</h4>${body}</section>` : "");
    const table = (head, trs) => (trs.length ? `<table class="imp-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${trs.join("")}</tbody></table>` : "");

    const conflictRows = conflicts.map(
      (r, i) => `<tr><td>${nameCell(r.old)}</td><td>${dockCell(r)}</td><td>${movedCell(r)}</td>
        <td class="imp-choice">
          <label><input type="radio" name="cf${i}" data-row="${rows.indexOf(r)}" value="excel"${r.action === "excel" ? " checked" : ""}> 用新版 Excel</label>
          <label><input type="radio" name="cf${i}" data-row="${rows.indexOf(r)}" value="web"${r.action === "web" ? " checked" : ""}> 保留網頁版本</label>
        </td></tr>`
    );
    const updateRows = updates.map((r) => `<tr><td>${nameCell(r.old)}</td><td>${dockCell(r)}</td><td>${movedCell(r)}</td></tr>`);
    const freshRows = fresh.map(
      (r) => `<tr><td>${nameCell(r.np, `<span class="tag imp-new">新分頁</span>`)}</td>
        <td colspan="2"><label class="imp-map">對應到舊分頁（改名）：
          <select data-map="${rows.indexOf(r)}"><option value="">— 不對應，當成新分頁 —</option>${goneOpts
            .map((o) => `<option value="${o.id}"${r.map === o.id ? " selected" : ""}>${U.esc(o.sheet)}</option>`)
            .join("")}</select></label></td></tr>`
    );
    const mappedIds = new Set(fresh.map((r) => r.map).filter(Boolean));
    const goneRows = gone
      .filter((r) => !mappedIds.has(r.old.id))
      .map(
        (r) => `<tr><td>${nameCell(r.old, r.edited ? `<span class="tag focus">網頁有修改</span>` : "")}</td>
        <td colspan="2"><span class="muted">新版 Excel 沒有這個分頁</span></td>
        <td class="imp-choice">
          <label><input type="radio" name="gone${rows.indexOf(r)}" data-gone="${rows.indexOf(r)}" value="remove"${r.action === "remove" ? " checked" : ""}> 移除</label>
          <label><input type="radio" name="gone${rows.indexOf(r)}" data-gone="${rows.indexOf(r)}" value="keep"${r.action === "keep" ? " checked" : ""}> 保留</label>
        </td></tr>`
      );

    const chip = (n, label, cls) => (n ? `<span class="imp-chip ${cls}"><b>${n}</b>${label}</span>` : "");
    const cal = plan.calDiff.length
      ? `假日表變動：${plan.calDiff.map((c) => `${c.site} ${c.add ? `+${c.add}` : ""}${c.del ? ` −${c.del}` : ""}`).join("、")}（以新版 Excel 為準）`
      : "假日表沒有變動";

    d.querySelector(".imp-body").innerHTML = `
      <p class="imp-file">📄 <b>${U.esc(plan.fileName)}</b>　${plan.incoming.pfams.length} 個排程分頁（${plan.incoming.pfams.filter((p) => !p.hidden).length} 個可見）</p>
      <div class="imp-chips">
        ${chip(conflicts.length, "需要決定", "c-conflict")}${chip(updates.length, "將更新", "c-update")}${chip(fresh.length, "新分頁", "c-new")}${chip(goneRows.length, "Excel 已無", "c-gone")}${chip(keepweb.length, "保留網頁修改", "c-keep")}${chip(same.length, "無變動", "c-same")}
      </div>
      <p class="muted imp-note">${cal}。匯入後，▲▼ 會以「上一版」的日期為基準顯示延後／提前。${plan.webOnly.length ? `網頁上建立的 ${plan.webOnly.length} 個分頁會保留。` : ""}</p>
      ${sec("需要你決定", "：這些分頁在網頁上改過，新版 Excel 也改了", table(["分頁", "Dock（舊 → 新版 Excel）", "變動", "要用哪個版本"], conflictRows), "s-conflict")}
      ${sec("新增／移除的分頁", "：分頁名稱不同的會被當成新增＋移除，改名的請手動對應", table(["分頁", "", "", ""], freshRows.concat(goneRows)), "s-new")}
      ${sec("將以新版 Excel 更新", "", table(["分頁", "Dock（舊 → 新）", "變動"], updateRows), "s-update")}
      ${keepweb.length ? sec("Excel 沒變、保留網頁修改", "", `<p class="imp-list">${keepweb.map((r) => U.esc(r.old.sheet)).join("、")}</p>`) : ""}
      ${same.length ? `<details class="imp-same"><summary>無變動的 ${same.length} 個分頁</summary><p class="imp-list">${same.map((r) => U.esc(r.old.sheet)).join("、")}</p></details>` : ""}
      ${!conflicts.length && !updates.length && !fresh.length && !goneRows.length && !plan.calDiff.length ? `<p class="imp-nothing">新版 Excel 與目前資料相同，沒有需要更新的內容。</p>` : ""}`;
  }

  function onDialogChange(ev) {
    const t = ev.target;
    if (t.dataset.row) plan.rows[+t.dataset.row].action = t.value;
    if (t.dataset.gone) plan.rows[+t.dataset.gone].action = t.value;
    if (t.dataset.map) {
      plan.rows[+t.dataset.map].map = t.value;
      render();
    }
  }

  // ---------------------------------------------------------------- apply
  /** New Excel content for an existing sheet: keep its id/sync/group, baseline = previous version. */
  function takeExcel(old, np, prevFile) {
    const p = clone(np);
    p.id = old.id;
    p.version = old.version;
    if (old.group) p.group = old.group;
    const prev = prevDates(old);
    const m = matchTasks(old, np);
    for (const t of p.tasks) {
      if (t.type !== "task") continue;
      const ot = m.get(t.id);
      const d = ot && prev.get(ot.id);
      if (d && (d.start || d.end)) t.base = { start: d.start, end: d.end };
      else delete t.base; // new in this version: nothing to compare with
    }
    p.baselineAt = new Date().toISOString();
    p.baselineLabel = `上一版 Excel${prevFile ? `（${prevFile}）` : ""}`;
    return p;
  }

  function apply() {
    const incoming = plan.incoming;
    const prevFile = (Store.data.source || {}).file || "";
    undoSnapshot = { data: JSON.stringify(Store.data), selected: Store.ui.selectedId };
    const oldById = new Map(Store.data.pfams.map((p) => [p.id, p]));
    const usedIds = new Set(Store.data.pfams.map((p) => p.id));
    const changed = new Set();
    const result = [];
    const placed = new Set();
    const mapBy = new Map(plan.rows.filter((r) => r.kind === "new" && r.map).map((r) => [r.np.xlSheet, r.map]));
    const rowBy = new Map(plan.rows.filter((r) => r.np).map((r) => [r.np.xlSheet, r]));

    for (const np of incoming.pfams) {
      const r = rowBy.get(np.xlSheet);
      const mappedOld = mapBy.get(np.xlSheet) && oldById.get(mapBy.get(np.xlSheet));
      if (r.kind === "new" && !mappedOld) {
        const p = clone(np);
        if (usedIds.has(p.id)) p.id = U.uid("p");
        usedIds.add(p.id);
        result.push(p);
        changed.add(p.id);
        continue;
      }
      const old = mappedOld || r.old;
      placed.add(old.id);
      if (r.kind === "same" || r.kind === "keepweb" || (r.kind === "conflict" && r.action === "web")) {
        const keep = old;
        // Keeping the web version: the new Excel becomes its reference for the next comparison
        // (also for edits made before references were tracked, so the next import still sees them).
        if (r.kind === "conflict" || r.kind === "keepweb") {
          keep._xl = clone(np);
          keep._xl.id = keep.id;
          changed.add(keep.id);
        }
        result.push(keep);
        continue;
      }
      result.push(takeExcel(old, np, prevFile));
      changed.add(old.id);
    }

    // Keep web-only sheets and vanished sheets the user chose to keep, next to their old neighbours.
    const deleted = [];
    const oldList = Store.data.pfams;
    oldList.forEach((p, i) => {
      if (placed.has(p.id)) return;
      const goneRow = plan.rows.find((r) => r.kind === "gone" && r.old.id === p.id);
      const keep = !Store.fromExcel(p) || (goneRow && goneRow.action === "keep" && ![...mapBy.values()].includes(p.id));
      if (!keep) {
        deleted.push(p.id);
        return;
      }
      let at = result.length;
      for (let j = i - 1; j >= 0; j--) {
        const k = result.findIndex((x) => x.id === oldList[j].id);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      result.splice(at, 0, p);
      placed.add(p.id);
    });
    result.forEach((p, i) => (p.order = i + 1));

    const next = {
      ...Store.data,
      source: { ...incoming.source, uploaded: true, previous: prevFile },
      calendars: incoming.calendars,
      pfams: result,
      deleted: [...new Set([...(Store.data.deleted || []), ...deleted])],
      calendarsDirty: plan.calDiff.length ? true : Store.data.calendarsDirty,
    };
    Store.replaceData(next, { keepDirty: true });
    for (const id of changed) Store.dirty.add(id);
    Store.markClean([]); // persist the dirty set
    if (Store.ui.selectedId && !Store.ui.selectedId.startsWith("g:") && !Store.pfam(Store.ui.selectedId)) Store.setUi({ selectedId: null });
    Store.emit("data", { replaced: true });

    const n = changed.size;
    App.toast(`已匯入 ${plan.fileName}：更新 ${n} 個分頁${deleted.length ? `、移除 ${deleted.length} 個` : ""}`, "", [{ label: "復原匯入", run: undoImport }]);
    plan = null;
  }

  function undoImport() {
    if (!undoSnapshot) return;
    const before = JSON.parse(undoSnapshot.data);
    const nowIds = new Set(Store.data.pfams.map((p) => p.id));
    const beforeIds = new Set(before.pfams.map((p) => p.id));
    // Sheets added by the import must be removed from the cloud again; everything else re-pushed.
    before.deleted = [...(before.deleted || []).filter((id) => !beforeIds.has(id)), ...[...nowIds].filter((id) => !beforeIds.has(id))];
    before.calendarsDirty = true;
    Store.replaceData(before, { keepDirty: true });
    for (const p of before.pfams) Store.dirty.add(p.id);
    Store.markClean([]);
    Store.setUi({ selectedId: undoSnapshot.selected });
    Store.emit("data", { replaced: true });
    undoSnapshot = null;
    App.toast("已復原到匯入前的資料");
  }

  // ---------------------------------------------------------------- entry
  async function pick(file) {
    if (!file) return;
    App.toast(`讀取 ${file.name}…`);
    try {
      const XLSX = await loadXlsx();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellFormula: true, cellNF: true, cellDates: false });
      const incoming = Importer.convert(XLSX, wb, file.name);
      plan = buildPlan(incoming, file.name);
      render();
      $("#dlgImport").showModal();
    } catch (err) {
      console.error(err);
      App.toast("讀取 Excel 失敗：" + err.message, "error");
    }
  }

  function bind() {
    $("#fileXlsx").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      ev.target.value = "";
      pick(f);
    });
    const d = $("#dlgImport");
    d.addEventListener("change", onDialogChange);
    $("#impApply").addEventListener("click", () => {
      d.close();
      apply();
    });
  }

  window.XlImport = { bind, open: () => $("#fileXlsx").click(), pick, _buildPlan: buildPlan };
})();
