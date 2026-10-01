/* Editable raw-data table for one PFAM. Edits go through Store and re-render the Gantt live. */
(function () {
  const E = window.Engine;

  const MODES = [
    ["dep", "依前置"],
    ["manual", "固定日期"],
    ["none", "未排程"],
  ];

  function calOptions(t, calendars) {
    const cur = t.startCal === t.endCal ? t.startCal || "site" : "mixed";
    const opts = [["site", "廠區假日"], ["none", "僅週末"]].concat(Object.keys(calendars).map((k) => [k, k]));
    if (cur === "mixed") opts.unshift(["mixed", "混合"]);
    return opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
  }

  const Table = {
    pfamId: null, // the sheet whose rows are on screen (in a merged view: the active build tab)

    /** cloudDiff: task id -> local-vs-cloud difference (CloudDiff), or null. */
    render(root, pfam, sched, cloudDiff) {
      this.pfamId = pfam.id;
      const calendars = Store.data.calendars;
      const wbs = sched.wbs;
      const active = document.activeElement;
      const focusKey = active && root.contains(active) && active.dataset.f ? { tid: active.dataset.tid, f: active.dataset.f } : null;

      const wbsOptions = pfam.tasks
        .filter((t) => t.type === "task" && wbs.get(t.id))
        .map((t) => `<option value="${U.esc(wbs.get(t.id))}">${U.esc(t.name)}</option>`)
        .join("");

      const rows = pfam.tasks.map((t, i) => {
        const r = sched.rows.get(t.id) || {};
        const w = U.esc(wbs.get(t.id));
        const cd = cloudDiff && cloudDiff.get(t.id);
        const acts = `<td class="acts">
            <button data-act="up" data-tid="${t.id}" title="上移" aria-label="上移"${i === 0 ? " disabled" : ""}>↑</button>
            <button data-act="down" data-tid="${t.id}" title="下移" aria-label="下移"${i === pfam.tasks.length - 1 ? " disabled" : ""}>↓</button>
            <button data-act="add" data-tid="${t.id}" title="在下方插入任務" aria-label="在下方插入任務">＋</button>
            <button data-act="del" data-tid="${t.id}" title="刪除" aria-label="刪除" class="danger">✕</button>
          </td>`;
        if (t.type === "section") {
          return `<tr class="sec${cd ? ` cd-${cd.kind}` : ""}" data-row="${t.id}">
            <td class="wbs">${w}${CloudDiff.rowBadge(cd)}</td>
            <td colspan="13"><input class="in sec-name" data-tid="${t.id}" data-f="name" value="${U.esc(t.name)}" aria-label="區段名稱"></td>
            ${acts}</tr>`;
        }
        const derivedStart = t.startMode === "dep";
        const derivedEnd = t.endMode !== "manual";
        const pred = t.pred ? wbs.get(t.pred) || "" : t.predMissing || "";
        const be = t.base && E.toDay(t.base.end);
        let diff = "";
        if (be != null && r.end != null && be !== r.end) {
          const d = r.end - be;
          diff = `<span class="${d > 0 ? "late" : "early"}">${d > 0 ? "▲" : "▼"}${U.signedDays(d)}</span>`;
        }
        const err = r.error ? `<span class="warn" title="${U.esc(r.error)}">⚠</span>` : "";
        const focus = Store.ui.highlight ? U.matchRoles(t.lead, Store.ui.focusRoles) : [];
        const cls = [r.error ? "has-err" : "", focus.length ? "focus" : "", cd ? `cd-${cd.kind}` : ""].filter(Boolean).join(" ");
        return `<tr data-row="${t.id}"${cls ? ` class="${cls}"` : ""}>
          <td class="wbs">${w}${err}${CloudDiff.rowBadge(cd)}${focus.length ? `<span class="role-pill">${U.esc(focus.join("/"))}</span>` : ""}</td>
          <td><input class="in name" data-tid="${t.id}" data-f="name" value="${U.esc(t.name)}" aria-label="任務名稱"></td>
          <td><input class="in lead" data-tid="${t.id}" data-f="lead" value="${U.esc(t.lead)}" aria-label="負責單位"></td>
          <td><select class="in" data-tid="${t.id}" data-f="startMode" aria-label="開始規則">${MODES.map(([v, l]) => `<option value="${v}"${v === t.startMode ? " selected" : ""}>${l}</option>`).join("")}</select></td>
          <td><input class="in num pred" data-tid="${t.id}" data-f="pred" value="${U.esc(pred)}" list="wbsList" placeholder="—" aria-label="前置 WBS"${t.startMode !== "dep" ? " disabled" : ""}></td>
          <td><input class="in num" type="number" step="1" data-tid="${t.id}" data-f="lag" value="${t.startMode === "dep" ? t.lag : ""}" aria-label="Lag 工作天"${t.startMode !== "dep" ? " disabled" : ""}></td>
          <td><input class="in date${derivedStart ? " derived" : ""}" type="date" data-tid="${t.id}" data-f="start" value="${E.fromDay(r.start) || ""}" aria-label="開始日期" title="${derivedStart ? "由前置任務推算；直接輸入日期會改為固定日期" : ""}"></td>
          <td><input class="in num" type="number" min="0" step="1" data-tid="${t.id}" data-f="workdays" value="${t.workdays == null ? "" : t.workdays}" aria-label="工作天"></td>
          <td><input class="in date${derivedEnd ? " derived" : ""}" type="date" data-tid="${t.id}" data-f="end" value="${E.fromDay(r.end) || ""}" aria-label="結束日期" title="${derivedEnd ? "由開始日 + 工作天推算；直接輸入會回推工作天" : "固定結束日"}"></td>
          <td class="ro num">${r.days || ""}</td>
          <td><input class="in num pct" type="number" min="0" max="100" step="5" data-tid="${t.id}" data-f="pct" value="${t.pct || 0}" aria-label="完成百分比"></td>
          <td><select class="in cal" data-tid="${t.id}" data-f="cal" aria-label="日曆">${calOptions(t, calendars)}</select></td>
          <td class="ro diff">${diff}</td>
          <td><textarea class="in notes" rows="1" data-tid="${t.id}" data-f="notes" aria-label="備註">${U.esc(t.notes)}</textarea></td>
          ${acts}</tr>`;
      });

      root.innerHTML = `
        <datalist id="wbsList">${wbsOptions}</datalist>
        <div class="table-scroll">
          <table class="raw">
            <thead><tr>
              <th>WBS</th><th>任務</th><th>負責</th><th>開始規則</th><th>前置</th><th title="前置完成後第幾個工作天開始（Excel WORKDAY 的位移）">Lag</th>
              <th>開始</th><th>工作天</th><th>結束</th><th>日曆天</th><th>完成%</th><th>日曆</th><th title="結束日相對基準（匯入時的 Excel 值）">vs 基準</th><th>備註</th><th></th>
            </tr></thead>
            <tbody>${rows.join("")}</tbody>
          </table>
        </div>`;

      if (focusKey) {
        const n = root.querySelector(`[data-tid="${focusKey.tid}"][data-f="${focusKey.f}"]`);
        if (n) n.focus();
      }
      if (!root._bound) this.bind(root);
    },

    bind(root) {
      root._bound = true;
      root.addEventListener("change", (ev) => {
        const n = ev.target;
        if (!n.dataset || !n.dataset.f) return;
        this.commit(n.dataset.tid, n.dataset.f, n.type === "checkbox" ? n.checked : n.value);
      });
      root.addEventListener("keydown", (ev) => {
        const n = ev.target;
        if (ev.key !== "Enter" || !n.dataset || !n.dataset.f || n.tagName === "TEXTAREA") return;
        ev.preventDefault();
        const tr = n.closest("tr");
        let next = tr && tr.nextElementSibling;
        while (next && !next.querySelector(`[data-f="${n.dataset.f}"]:not([disabled])`)) next = next.nextElementSibling;
        if (next) next.querySelector(`[data-f="${n.dataset.f}"]`).focus();
        else n.blur();
      });
      root.addEventListener("click", (ev) => {
        const b = ev.target.closest("button[data-act]");
        if (!b) return;
        const p = Store.pfam(this.pfamId);
        const id = b.dataset.tid;
        if (b.dataset.act === "up") Store.moveTask(p.id, id, -1);
        if (b.dataset.act === "down") Store.moveTask(p.id, id, 1);
        if (b.dataset.act === "add") {
          const t = Store.insertTask(p.id, id, "task");
          if (t) App.focusRow(t.id, "name");
        }
        if (b.dataset.act === "del") {
          const t = Store.task(p, id);
          if (t && confirm(`刪除「${t.name}」？\n依賴它的任務會改為固定日期（保留目前日期）。可用 Ctrl+Z 復原。`)) Store.deleteTask(p.id, id);
        }
      });
    },

    commit(tid, field, value) {
      const p = Store.pfam(this.pfamId);
      if (!p) return;
      const t = Store.task(p, tid);
      if (!t) return;
      const sched = Store.sched(p);
      const r = sched.rows.get(tid) || {};
      const patch = {};

      switch (field) {
        case "name":
        case "lead":
        case "notes":
          patch[field] = value.trim();
          break;
        case "startMode":
          patch.startMode = value;
          if (value === "dep" && !t.pred) {
            const i = p.tasks.indexOf(t);
            const prev = p.tasks.slice(0, i).reverse().find((x) => x.type === "task");
            patch.pred = prev ? prev.id : null;
            patch.lag = t.lag != null ? t.lag : 1;
          }
          if (value === "manual") patch.start = E.fromDay(r.start) || new Date().toISOString().slice(0, 10);
          if (value === "none") patch.start = null;
          break;
        case "pred": {
          const w = value.trim();
          if (!w) {
            Object.assign(patch, { startMode: "manual", pred: null, start: E.fromDay(r.start) });
            break;
          }
          const id = [...sched.wbs.entries()].find(([k, v]) => v === w && Store.task(p, k).type === "task");
          if (!id) {
            App.toast(`找不到 WBS「${w}」的任務`, "error");
            App.renderSoon();
            return;
          }
          if (id[0] === tid) {
            App.toast("任務不能以自己為前置", "error");
            App.renderSoon();
            return;
          }
          Object.assign(patch, { pred: id[0], predMissing: undefined, startMode: "dep" });
          break;
        }
        case "lag":
          patch.lag = Math.trunc(Number(value) || 0);
          break;
        case "start":
          if (!value) Object.assign(patch, { startMode: "none", start: null });
          else Object.assign(patch, { startMode: "manual", start: value }); // pred is kept so "依前置" can be restored
          break;
        case "workdays":
          patch.workdays = value === "" ? null : Math.max(0, Math.trunc(Number(value)));
          patch.endMode = "dur";
          break;
        case "end": {
          if (!value) {
            Object.assign(patch, { endMode: "dur", end: null });
            break;
          }
          const endDay = E.toDay(value);
          const hol = E.calFor(t.endCal, p, Store.data.calendars);
          if (r.start != null && endDay < r.start) {
            App.toast("結束日不能早於開始日", "error");
            App.renderSoon();
            return;
          }
          if (r.start != null && E.isWorkday(endDay, hol)) {
            // WORKDAY(start, k) === end where k = workdays in (start, end]
            const k = endDay === r.start ? 0 : E.networkdays(r.start + 1, endDay, hol);
            Object.assign(patch, { endMode: "dur", end: null, workdays: k - (Number(t.endAdj) || 0) });
          } else Object.assign(patch, { endMode: "manual", end: value });
          break;
        }
        case "pct":
          patch.pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
          break;
        case "cal":
          if (value !== "mixed") Object.assign(patch, { startCal: value, endCal: value });
          break;
        default:
          return;
      }
      Store.updateTask(p.id, tid, patch);
    },
  };

  window.Table = Table;
})();
