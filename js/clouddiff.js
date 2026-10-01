/*
 * Local vs cloud: what an unsynced PFAM changed compared with the copy last read from / written to the cloud
 * (Store.cloudBase). Tasks are paired by id + name, then by name in order of appearance, then by id, so rows
 * inserted by an Excel import (which renumbers ids) do not make every later task look changed.
 *   changed = a stored field differs   added = not in the cloud copy   moved = only its computed dates differ
 */
(function () {
  const E = window.Engine;
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const blank = (v) => v === "" || v === null || v === undefined || v === false;
  const TASK_FIELDS = [
    ["name", "名稱"], ["lead", "負責"], ["startMode", "開始規則"], ["lag", "Lag", 0], ["start", "開始日"],
    ["workdays", "工作天"], ["endMode", "結束規則"], ["endAdj", "結束調整", 0], ["end", "結束日"],
    ["startCal", "日曆"], ["endCal", "日曆"], ["pct", "完成%", 0], ["notes", "備註"], ["code", "代碼"], ["unnumbered", "編號"],
  ];
  const PFAM_FIELDS = [["sheet", "名稱"], ["title", "標題"], ["site", "廠區"], ["calendar", "假日曆"], ["hidden", "封存"], ["assumptions", "假設與風險"], ["group", "合併群組"]];
  const META_FIELDS = [["lead", "Project Lead"], ["mdm", "MDM"], ["l10pn", "L10 PN"], ["l11pn", "L11 PN"]];
  const KIND_LABEL = { changed: "改", added: "新", moved: "連動" };
  const KIND_TITLE = { changed: "本機修改過（與雲端不同）", added: "本機新增（雲端沒有）", moved: "前置任務變動，日期跟著移動" };

  function same(a, b, dflt) {
    if (dflt !== undefined) return (Number(a) || dflt) === (Number(b) || dflt);
    return (blank(a) && blank(b)) || String(a) === String(b);
  }

  /** Pair each local task with its cloud counterpart (or none). */
  function pairTasks(local, cloud) {
    const byId = new Map(cloud.tasks.map((t) => [t.id, t]));
    const used = new Set();
    const pair = new Map();
    const take = (t, c) => {
      if (!c || used.has(c.id) || c.type !== t.type) return false;
      used.add(c.id);
      pair.set(t.id, c);
      return true;
    };
    for (const t of local.tasks) {
      const c = byId.get(t.id);
      if (c && norm(c.name) === norm(t.name)) take(t, c);
    }
    // Same name: the k-th unpaired local "X" pairs with the k-th unpaired cloud "X".
    const queues = new Map();
    for (const c of cloud.tasks) {
      if (used.has(c.id)) continue;
      const k = c.type + "|" + norm(c.name);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push(c);
    }
    for (const t of local.tasks) {
      if (pair.has(t.id)) continue;
      const q = queues.get(t.type + "|" + norm(t.name));
      if (q && q.length) take(t, q.shift());
    }
    for (const t of local.tasks) if (!pair.has(t.id)) take(t, byId.get(t.id));
    return { pair, used };
  }

  const CloudDiff = {
    KIND_LABEL,
    KIND_TITLE,

    /** The PFAM has edits that are not in the cloud yet. */
    pending(pfamId) {
      return !!(window.Remote && Remote.active && Store.dirty.has(pfamId) && Store.pfam(pfamId));
    },

    badge(title) {
      return `<span class="unsynced" title="${U.esc(title || "本機有尚未同步到雲端的修改")}" aria-label="尚未同步">⇪</span>`;
    },

    /**
     * Differences of one PFAM, or null when it has nothing unsynced.
     * { unknown } when the cloud copy is not available (cloud not reached yet), { isNew } for a sheet not in the cloud.
     */
    of(p) {
      if (!this.pending(p.id)) return null;
      const cloud = Store.cloudBase[p.id];
      const out = { isNew: false, unknown: false, tasks: new Map(), removed: [], fields: [], baseChanged: 0, counts: { changed: 0, added: 0, moved: 0, removed: 0 } };
      if (!cloud) {
        if (p.version) return { ...out, unknown: true };
        out.isNew = true;
        for (const t of p.tasks) out.tasks.set(t.id, { kind: "added" });
        out.counts.added = p.tasks.filter((t) => t.type === "task").length;
        return out;
      }

      for (const [k, label] of PFAM_FIELDS) if (!same(p[k], cloud[k])) out.fields.push(label);
      for (const [k, label] of META_FIELDS) if (!same((p.meta || {})[k], (cloud.meta || {})[k])) out.fields.push(label);

      const s = Store.sched(p);
      const cs = E.schedule(cloud, Store.data.calendars);
      const cw = E.wbsMap(cloud);
      const { pair, used } = pairTasks(p, cloud);
      for (const t of p.tasks) {
        const c = pair.get(t.id);
        if (!c) {
          out.tasks.set(t.id, { kind: "added" });
          if (t.type === "task") out.counts.added++;
          continue;
        }
        const fields = [];
        if (!same(t.name, c.name)) fields.push("名稱");
        if (t.type === "task") {
          for (const [k, label, dflt] of TASK_FIELDS) if (k !== "name" && !same(t[k], c[k], dflt) && !fields.includes(label)) fields.push(label);
          // Same predecessor = the cloud counterpart of the local predecessor (WBS numbers shift when rows move).
          const lp = t.pred ? pair.get(t.pred) : null;
          const predSame = t.pred || c.pred ? !!(lp && lp.id === c.pred) : same(t.predMissing, c.predMissing);
          if (!predSame) fields.push("前置");
          const tb = t.base || {};
          const cb = c.base || {};
          if (!same(tb.start, cb.start) || !same(tb.end, cb.end)) out.baseChanged++;
        }
        const r = s.rows.get(t.id) || {};
        const cr = cs.rows.get(c.id) || {};
        const moved = t.type === "task" && (r.start !== cr.start || r.end !== cr.end);
        const kind = fields.length ? "changed" : moved ? "moved" : null;
        if (!kind) continue;
        out.tasks.set(t.id, { kind, fields, cloud: { start: cr.start, end: cr.end }, moved });
        if (t.type === "task") out.counts[kind]++;
      }
      for (const c of cloud.tasks) {
        if (used.has(c.id) || c.type === "lane") continue;
        out.removed.push({ wbs: cw.get(c.id) || "", name: c.name, type: c.type });
        if (c.type === "task") out.counts.removed++;
      }
      if (out.baseChanged) out.fields.push(`基準日期（${out.baseChanged} 個任務）`);
      return out;
    },

    /** Task id -> diff for what a Gantt/table draws; merged group views prefix ids with "<pfamId>:". */
    taskMap(entries, prefixed) {
      const map = new Map();
      for (const { p, d } of entries) {
        if (!d || d.unknown) continue;
        for (const [id, info] of d.tasks) map.set(prefixed ? p.id + ":" + id : id, info);
      }
      return map;
    },

    /** Summary strip above the detailed Gantt. entries: [{ p, build?, d }] */
    bannerHtml(entries, showing) {
      const live = entries.filter((e) => e.d);
      if (!live.length) return "";
      const chip = (n, kind, label) => (n ? `<span class="cd-chip cd-${kind}"><b>${n}</b>${label}</span>` : "");
      const lines = live.map(({ p, build, d }) => {
        const who = live.length > 1 || build ? `<span class="build-pill">${U.esc(build || p.sheet)}</span>` : "";
        if (d.unknown) return `<div class="cd-line">${who}<span class="muted">尚未取得雲端版本，連上雲端後才能比對差異</span></div>`;
        if (d.isNew) return `<div class="cd-line">${who}<span class="cd-chip cd-added">本機新增的分頁</span><span class="muted">雲端還沒有，${d.counts.added} 個任務</span></div>`;
        const c = d.counts;
        const chips = chip(c.changed, "changed", "修改") + chip(c.added, "added", "新增") + chip(c.removed, "removed", "刪除") + chip(c.moved, "moved", "日期連動");
        const fields = d.fields.length ? `<span class="cd-fields">專案資訊：${d.fields.map(U.esc).join("、")}</span>` : "";
        const none = !chips && !fields ? `<span class="muted">內容與雲端相同（例如改了又復原），同步時會重新上傳</span>` : "";
        const removed = d.removed.length
          ? `<details class="cd-removed"><summary>雲端有、本機已刪除的 ${d.removed.length} 列</summary><ul>${d.removed
              .map((r) => `<li><span class="c-wbs">${U.esc(r.wbs)}</span>${r.type === "section" ? "〔區段〕" : ""}${U.esc(r.name)}</li>`)
              .join("")}</ul></details>`
          : "";
        return `<div class="cd-line">${who}${chips}${fields}${none}</div>${removed}`;
      });
      const any = live.some((e) => e.d.tasks && e.d.tasks.size);
      return `<div class="cd-head"><span class="cd-icon" aria-hidden="true">⇪</span><b>本機修改尚未同步到雲端</b><span class="muted">與雲端版本比對：</span>
          <span class="spacer"></span>
          ${any ? `<label class="toggle"><input type="checkbox" data-cd="mark"${showing ? " checked" : ""}> 在甘特圖與表格標示差異</label>` : ""}
          <button type="button" class="btn sync-now" data-cd="sync">⇪ 同步到雲端…</button>
        </div>${lines.join("")}`;
    },

    legendHtml() {
      return `<span><i class="lg-cd cd-changed"></i>本機修改</span><span><i class="lg-cd cd-added"></i>本機新增</span><span><i class="lg-cd cd-moved"></i>日期連動</span><span><i class="lg-cloud"></i>雲端版本位置</span>`;
    },

    /** Row badge for a Gantt label / table WBS cell. */
    rowBadge(info) {
      if (!info) return "";
      const extra = info.fields && info.fields.length ? `：${info.fields.join("、")}` : "";
      return `<span class="cd-badge cd-${info.kind}" title="${U.esc(KIND_TITLE[info.kind] + extra)}">${KIND_LABEL[info.kind]}</span>`;
    },

    /** Extra tooltip rows for a task. */
    tipHtml(info) {
      if (!info) return "";
      if (info.kind === "added") return `<div class="tip-cd cd-added">本機新增，雲端沒有這個任務</div>`;
      const what = info.kind === "changed" ? `本機修改：${U.esc(info.fields.join("、"))}` : "前置任務變動，日期跟著移動";
      const when = info.moved ? `<div class="tip-row"><span>雲端日期</span><b>${U.fmt(info.cloud.start, "full") || "—"} → ${U.fmt(info.cloud.end, "full") || "—"}</b></div>` : "";
      return `<div class="tip-cd cd-${info.kind}">${what}</div>${when}`;
    },
  };

  window.CloudDiff = CloudDiff;
})();
