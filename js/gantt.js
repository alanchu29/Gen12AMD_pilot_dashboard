/* Detailed Gantt for one PFAM (or a merged PFAM group with one lane per build): sticky labels + SVG timeline. */
(function () {
  const E = window.Engine;
  const ROW_H = 28;
  const BAR_H = 14;
  const HEAD_H = 46;
  const ZOOM = {
    day: { ppd: 26, pad: 5 },
    week: { ppd: 7, pad: 14 },
    month: { ppd: 2.4, pad: 31 },
  };
  const KEY_LABELS = { PlannedShipDate: "ETD", PlannedETADockDate: "Dock", BuildStartDate: "L10 Build", L11ShipGoNoGoDate: "Go/No-Go" };
  const SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function monthStart(day) {
    const d = new Date(day * 86400000);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000);
  }
  function addMonths(day, n) {
    const d = new Date(day * 86400000);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 86400000);
  }

  function colorSlot(t, sectionIdx, colorBy) {
    if (colorBy === "section") return sectionIdx < 0 ? 0 : (sectionIdx % 8) + 1;
    const g = U.OWNER_GROUPS.find((x) => x.key === U.ownerGroup(t.lead));
    return g ? g.slot : 0;
  }

  /** Rows actually drawn: respects collapsed lanes/sections and the "only my tasks" filter. */
  function visibleRows(pfam, isCollapsed, roles, onlyFocus) {
    const rows = [];
    let secIdx = -1;
    let hide = false;
    let laneHide = false;
    let zebra = 0;
    for (const t of pfam.tasks) {
      if (t.type === "lane") {
        laneHide = isCollapsed(t.id);
        hide = false;
        rows.push({ t, lane: true, collapsed: laneHide });
        continue;
      }
      if (laneHide) continue;
      if (t.type === "section") {
        secIdx++;
        hide = isCollapsed(t.id);
        zebra = 0;
        rows.push({ t, secIdx, section: true, collapsed: hide });
        continue;
      }
      const focus = U.matchRoles(t.lead, roles);
      if (hide || (onlyFocus && !focus.length)) continue;
      rows.push({ t, secIdx, section: false, focus, zebra: zebra++ % 2 === 1 });
    }
    // Drop sections left empty by the focus filter.
    if (onlyFocus) return rows.filter((r, i) => !r.section || r.collapsed || (rows[i + 1] && !rows[i + 1].section && !rows[i + 1].lane));
    return rows;
  }

  const Gantt = {
    lastPfamId: null,

    render(root, pfam, sched, opts) {
      const ui = opts.ui;
      const zoom = ZOOM[ui.zoom] || ZOOM.week;
      const ppd = zoom.ppd;
      const explicit = ui.collapsed[pfam.id] || {};
      const defaults = opts.defaultCollapsed || new Set();
      const isCollapsed = (id) => (id in explicit ? !!explicit[id] : defaults.has(id));
      const roles = ui.highlight || ui.onlyFocus ? ui.focusRoles : [];
      const rows = visibleRows(pfam, isCollapsed, roles, ui.onlyFocus && roles.length > 0);
      const hol = E.calFor("site", pfam, Store.data.calendars);
      const today = E.toDay(new Date().toISOString().slice(0, 10));

      // Range: dates of what is actually drawn (collapsed "same as 1st" sections don't stretch it), padded.
      let min = null;
      let max = null;
      const take = (v) => {
        if (v == null) return;
        min = min == null ? v : Math.min(min, v);
        max = max == null ? v : Math.max(max, v);
      };
      for (const r of rows) {
        const res = sched.rows.get(r.t.id) || {};
        if (r.section && r.collapsed && r.t._inherited) continue;
        take(res.start);
        take(res.end);
        if (!r.section && !r.lane && ui.showBaseline && r.t.base) {
          take(E.toDay(r.t.base.start));
          take(E.toDay(r.t.base.end));
        }
      }
      if (min == null) {
        min = sched.span.start;
        max = sched.span.end;
      }
      if (min == null) {
        root.innerHTML = `<div class="empty-note">此 PFAM 尚無任何有日期的任務。請在下方 Raw data 表新增或設定開始日期。</div>`;
        return;
      }
      let r0 = min - zoom.pad;
      let r1 = max + zoom.pad * 2;
      if (ui.zoom === "month") {
        r0 = monthStart(r0);
        r1 = addMonths(r1, 1) - 1;
      } else {
        r0 -= (E.weekday(r0) + 6) % 7; // back to Monday
      }
      const W = Math.ceil((r1 - r0 + 1) * ppd);
      const H = rows.length * ROW_H;
      const x = (day) => (day - r0) * ppd;

      // Preserve scroll unless we switched PFAM or zoom.
      const prev = root.querySelector(".gantt-scroll");
      const keep = prev && this.lastPfamId === pfam.id && this.lastZoom === ui.zoom;
      const scroll = keep ? { l: prev.scrollLeft, t: prev.scrollTop } : null;
      this.lastPfamId = pfam.id;
      this.lastZoom = ui.zoom;

      root.innerHTML = "";
      const scroller = document.createElement("div");
      scroller.className = "gantt-scroll";
      const inner = document.createElement("div");
      inner.className = "gantt-inner";
      inner.style.width = `calc(var(--label-w) + ${W}px)`;
      scroller.appendChild(inner);

      // ---- header
      const head = document.createElement("div");
      head.className = "g-head";
      head.innerHTML = `<div class="g-corner"><span class="c-wbs">WBS</span><span class="c-name">任務</span><span class="c-lead">負責</span></div>`;
      const axis = el("svg", { width: W, height: HEAD_H, class: "g-axis" });
      head.appendChild(axis);
      inner.appendChild(head);
      this.drawAxis(axis, r0, r1, x, ppd, ui.zoom, hol, today);

      // ---- body
      const body = document.createElement("div");
      body.className = "g-body";
      const labels = document.createElement("div");
      labels.className = "g-labels";
      const chart = el("svg", { width: W, height: Math.max(H, ROW_H), class: "g-chart" });
      body.appendChild(labels);
      body.appendChild(chart);
      inner.appendChild(body);

      const bg = el("g", {}, chart);
      const gridG = el("g", { class: "grid" }, chart);
      const baseG = el("g", {}, chart);
      const depG = el("g", { class: "deps" }, chart);
      const barG = el("g", {}, chart);

      // Alternating month bands help the eye track dates across long rows.
      for (let m = monthStart(r0); m <= r1; m = addMonths(m, 1)) {
        if (new Date(m * 86400000).getUTCMonth() % 2 === 1) {
          const a = Math.max(m, r0);
          el("rect", { x: x(a), y: 0, width: (addMonths(m, 1) - a) * ppd, height: H, class: "mband" }, bg);
        }
      }
      // Non-working days: weekends + holidays in day zoom; only holidays when zoomed out (weekend stripes are noise there).
      {
        const offDay = ui.zoom === "day" ? (d) => !E.isWorkday(d, hol) : (d) => !!(hol && hol.has(d));
        let runStart = null;
        for (let d = r0; d <= r1 + 1; d++) {
          const off = d <= r1 && offDay(d);
          if (off && runStart == null) runStart = d;
          if (!off && runStart != null) {
            el("rect", { x: x(runStart), y: 0, width: (d - runStart) * ppd, height: H, class: "nonwork" }, bg);
            runStart = null;
          }
        }
      }
      // Month gridlines
      for (let m = monthStart(r0); m <= r1; m = addMonths(m, 1)) {
        if (m >= r0) el("line", { x1: x(m) + 0.5, x2: x(m) + 0.5, y1: 0, y2: H, class: "gridline" }, gridG);
      }

      const rowIndex = new Map();
      rows.forEach((r, i) => rowIndex.set(r.t.id, i));

      rows.forEach((r, i) => {
        const t = r.t;
        const y = i * ROW_H;
        const res = sched.rows.get(t.id) || {};
        const wbs = sched.wbs.get(t.id);
        const cd = opts.diff && opts.diff.get(t.id);
        const cdCls = cd ? ` cd-${cd.kind}` : "";

        // label
        const lab = document.createElement("div");
        const hl = ui.highlight && r.focus && r.focus.length;
        lab.className = "g-row" + (r.lane ? " is-lane" : "") + (r.section ? " is-section" : "") + (r.section && t._inherited ? " inherited" : "") + (r.zebra ? " zebra" : "") + (hl ? " focus" : "") + cdCls;
        lab.dataset.id = t.id;
        const caret = (what) => `<button class="caret" data-toggle="${t.id}" aria-label="${r.collapsed ? "展開" : "收合"}${what}" aria-expanded="${!r.collapsed}">${r.collapsed ? "▸" : "▾"}</button>`;
        if (r.lane) {
          const dock = opts.laneDock && opts.laneDock[t.id];
          const unsynced = CloudDiff.pending(t._pfamId) ? CloudDiff.badge() : "";
          lab.innerHTML = `${caret("build")}<span class="lane-pill">${U.esc(t.build)}</span><span class="c-name" title="${U.esc(t.name)}">${U.esc(t.name)}</span>${unsynced}${dock != null ? `<span class="lane-dock">Dock ${U.fmt(dock, "md")}</span>` : ""}`;
        } else if (r.section) {
          const copied = t._total && t._copied / t._total >= 0.5
            ? `<span class="tag copy" title="${t._copied}/${t._total} 項任務的名稱與日期和其他分頁完全相同，疑似從其他分頁複製">疑似複製 ${t._copied}/${t._total}</span>`
            : "";
          const inh = t._inherited ? `<span class="tag inh" title="2nd build 的前段通常沿用 1st，預設收合">沿用 1st</span>${copied}` : "";
          lab.innerHTML = `${caret("區段")}<span class="c-wbs">${U.esc(wbs)}</span><span class="c-name" title="${U.esc(t.name)}">${U.esc(t.name)}</span>${CloudDiff.rowBadge(cd)}${inh}`;
        } else {
          const err = res.error ? `<span class="warn" title="${U.esc(res.error)}" aria-label="${U.esc(res.error)}">⚠</span>` : "";
          const pill = hl ? `<span class="role-pill">${U.esc(r.focus.join("/"))}</span>` : "";
          lab.innerHTML = `<span class="c-wbs">${U.esc(wbs)}</span><span class="c-name" title="${U.esc(t.name)}">${err}${U.esc(t.name)}</span>${CloudDiff.rowBadge(cd)}${pill}<span class="c-lead" title="${U.esc(t.lead)}">${U.esc(t.lead)}</span>`;
        }
        labels.appendChild(lab);

        // row hit area / highlight
        el("rect", { x: 0, y, width: W, height: ROW_H, class: "rowhit" + (r.lane ? " lane" : "") + (r.section ? " sec" : "") + (r.zebra ? " zebra" : "") + (hl ? " focus" : ""), "data-id": t.id }, bg);

        if (r.lane) {
          if (res.start != null && res.end != null) {
            el("rect", { x: x(res.start), y: y + ROW_H / 2 - 4, width: Math.max((res.end - res.start + 1) * ppd, 2), height: 8, rx: 4, class: "lanebar", "data-id": t.id }, barG);
          }
          return;
        }
        if (r.section) {
          if (r.collapsed && t._inherited) return; // stale copied dates would stretch a misleading bar
          if (res.start != null && res.end != null) {
            const x0 = x(res.start);
            const w = Math.max((res.end - res.start + 1) * ppd, 2);
            el("rect", { x: x0, y: y + ROW_H / 2 - 3, width: w, height: 6, rx: 1, class: "secbar", "data-id": t.id }, barG);
          }
          return;
        }

        // baseline ghost
        const bs = t.base && E.toDay(t.base.start);
        const be = t.base && E.toDay(t.base.end);
        const moved = t.base && (bs !== res.start || be !== res.end);
        if (ui.showBaseline && moved && (bs != null || be != null)) {
          const b0 = bs != null ? bs : be;
          const b1 = be != null ? be : bs;
          el("rect", { x: x(b0), y: y + ROW_H - 7, width: Math.max((b1 - b0 + 1) * ppd, 3), height: 3, rx: 1.5, class: "basebar" }, baseG);
        }

        // where the task sits in the cloud copy, when local edits moved it
        if (cd && cd.moved && (cd.cloud.start != null || cd.cloud.end != null)) {
          const c0 = cd.cloud.start != null ? cd.cloud.start : cd.cloud.end;
          const c1 = cd.cloud.end != null ? cd.cloud.end : cd.cloud.start;
          el("rect", { x: x(c0) + 0.5, y: y + ROW_H / 2 - BAR_H / 2 - 1.5, width: Math.max((c1 - c0 + 1) * ppd - 1, 4), height: BAR_H + 3, rx: 4, class: "cloudbar" }, baseG);
        }

        if (res.start == null && res.end == null) return;
        const s = res.start != null ? res.start : res.end;
        const e = res.end != null ? res.end : res.start;
        const slot = colorSlot(t, r.secIdx, ui.colorBy);
        const single = s === e && (Number(t.workdays) || 0) <= 1;
        const cy = y + ROW_H / 2;
        let endX;
        if (single) {
          const cx = x(s) + ppd / 2;
          const rr = 6;
          el("path", { d: `M${cx} ${cy - rr}L${cx + rr} ${cy}L${cx} ${cy + rr}L${cx - rr} ${cy}Z`, class: `ms s${slot}${hl ? " focus" : ""}${cdCls}`, "data-id": t.id }, barG);
          endX = cx + rr;
        } else {
          const x0 = x(s);
          const w = Math.max((e - s + 1) * ppd, 3);
          el("rect", { x: x0, y: cy - BAR_H / 2, width: w, height: BAR_H, rx: 3, class: `bar s${slot}${hl ? " focus" : ""}${cdCls}`, "data-id": t.id }, barG);
          const pct = Math.max(0, Math.min(100, Number(t.pct) || 0));
          if (pct > 0) el("rect", { x: x0, y: cy + BAR_H / 2 - 4, width: (w * pct) / 100, height: 4, rx: 2, class: "progress", "data-id": t.id }, barG);
          endX = x0 + w;
        }

        // Selective labels: key milestones and slips only.
        const bits = [];
        if (KEY_LABELS[t.code]) bits.push({ text: `${KEY_LABELS[t.code]} ${U.fmt(s, "short")}`, cls: "keylabel" });
        if (ui.showBaseline && be != null && res.end != null && be !== res.end) {
          const dlt = res.end - be;
          bits.push({ text: (dlt > 0 ? "▲" : "▼") + U.signedDays(dlt), cls: dlt > 0 ? "slip late" : "slip early" });
        }
        let lx = endX + 6;
        for (const b of bits) {
          const tx = el("text", { x: lx, y: cy + 4, class: b.cls }, barG);
          tx.textContent = b.text;
          lx += b.text.length * 6.6 + 8;
        }
        if (res.error) {
          const tx = el("text", { x: endX + 6, y: cy + 4, class: "slip late" }, barG);
          tx.textContent = "⚠ " + res.error;
        }
      });

      // Dependencies
      if (ui.showDeps) {
        rows.forEach((r, i) => {
          const t = r.t;
          if (r.section || r.lane || t.startMode !== "dep" || !t.pred || !rowIndex.has(t.pred)) return;
          const a = sched.rows.get(t.pred);
          const b = sched.rows.get(t.id);
          if (!a || !b || a.end == null || b.start == null) return;
          const j = rowIndex.get(t.pred);
          const x1 = x(a.end) + ppd;
          const y1 = j * ROW_H + ROW_H / 2;
          const x2 = x(b.start);
          const y2 = i * ROW_H + ROW_H / 2;
          const d = x2 - x1 >= 10
            ? `M${x1} ${y1}H${x1 + 5}V${y2}H${x2 - 1}`
            : `M${x1} ${y1}H${x1 + 5}V${y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2)}H${x2 - 8}V${y2}H${x2 - 1}`;
          el("path", { d, class: "dep", "marker-end": "url(#arrow)" }, depG);
        });
        const defs = el("defs", {}, chart);
        const mk = el("marker", { id: "arrow", viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
        el("path", { d: "M0 0L6 3L0 6Z", class: "dep-head" }, mk);
      }

      // Today
      if (today >= r0 && today <= r1) {
        el("line", { x1: x(today) + ppd / 2, x2: x(today) + ppd / 2, y1: 0, y2: H, class: "today" }, gridG);
      }

      root.appendChild(scroller);
      this.bind(root, scroller, pfam, sched, rows, opts);

      if (scroll) {
        scroller.scrollLeft = scroll.l;
        scroller.scrollTop = scroll.t;
      } else {
        // Open near today when it falls inside the range; stale early dates would otherwise fill the view with blank space.
        const anchor = today > min && today < max ? today - 14 : min;
        scroller.scrollLeft = Math.max(0, x(anchor) - 40);
      }
      this.scrollToDay = (day) => {
        scroller.scrollLeft = Math.max(0, x(day) - scroller.clientWidth / 3);
      };
    },

    drawAxis(svg, r0, r1, x, ppd, zoom, hol, today) {
      const top = el("g", {}, svg);
      const bot = el("g", {}, svg);
      el("line", { x1: 0, x2: x(r1 + 1), y1: HEAD_H - 0.5, y2: HEAD_H - 0.5, class: "axisline" }, svg);
      el("line", { x1: 0, x2: x(r1 + 1), y1: 22.5, y2: 22.5, class: "gridline" }, svg);

      const text = (g, tx, ty, s, cls) => {
        const n = el("text", { x: tx, y: ty, class: cls || "tick" }, g);
        n.textContent = s;
        return n;
      };

      if (zoom === "month") {
        // top: years; bottom: months
        for (let m = monthStart(r0); m <= r1; m = addMonths(m, 1)) {
          const d = new Date(m * 86400000);
          const mon = d.getUTCMonth();
          const w = (addMonths(m, 1) - m) * ppd;
          if (mon === 0 || m === monthStart(r0)) {
            text(top, x(Math.max(m, r0)) + 6, 16, `${d.getUTCFullYear()}`, "tick strong");
            el("line", { x1: x(m) + 0.5, x2: x(m) + 0.5, y1: 0, y2: 22, class: "gridline" }, top);
          }
          el("line", { x1: x(m) + 0.5, x2: x(m) + 0.5, y1: 23, y2: HEAD_H, class: "gridline" }, bot);
          if (w > 22) text(bot, x(m) + w / 2, 38, `${mon + 1}月`, "tick mid");
        }
      } else {
        for (let m = monthStart(r0); m <= r1; m = addMonths(m, 1)) {
          const d = new Date(m * 86400000);
          const xm = x(Math.max(m, r0));
          el("line", { x1: x(m) + 0.5, x2: x(m) + 0.5, y1: 0, y2: 22, class: "gridline" }, top);
          text(top, xm + 6, 16, `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`, "tick strong");
        }
        if (zoom === "day") {
          for (let d = r0; d <= r1; d++) {
            const off = !E.isWorkday(d, hol);
            text(bot, x(d) + ppd / 2, 38, String(new Date(d * 86400000).getUTCDate()), "tick mid" + (off ? " off" : ""));
          }
        } else {
          for (let d = r0; d <= r1; d++) {
            if (E.weekday(d) !== 1) continue;
            el("line", { x1: x(d) + 0.5, x2: x(d) + 0.5, y1: 23, y2: HEAD_H, class: "gridline" }, bot);
            text(bot, x(d) + 3, 38, U.fmt(d, "short"), "tick small");
          }
        }
      }
      if (today >= r0 && today <= r1) {
        const tx = x(today) + ppd / 2;
        el("line", { x1: tx, x2: tx, y1: 24, y2: HEAD_H, class: "today" }, svg);
        const lab = text(svg, tx, 34, "今天", "today-label");
        lab.setAttribute("text-anchor", "middle");
      }
    },

    bind(root, scroller, pfam, sched, rows, opts) {
      const byId = new Map(pfam.tasks.map((t) => [t.id, t]));
      let hot = null;
      const setHot = (id) => {
        if (hot === id) return;
        if (hot) root.querySelectorAll(`[data-id="${hot}"]`).forEach((n) => n.classList.remove("hot"));
        hot = id;
        if (hot) root.querySelectorAll(`[data-id="${hot}"]`).forEach((n) => n.classList.add("hot"));
      };

      scroller.addEventListener("mousemove", (ev) => {
        const n = ev.target.closest("[data-id]");
        const id = n ? n.dataset.id || n.getAttribute("data-id") : null;
        setHot(id);
        const onMark = n && n.matches(".bar, .ms, .secbar, .lanebar, .progress, .g-row");
        if (id && onMark) opts.tip.show(this.tipHtml(byId.get(id), sched, pfam, opts.diff && opts.diff.get(id)), ev);
        else opts.tip.hide();
      });
      scroller.addEventListener("mouseleave", () => {
        setHot(null);
        opts.tip.hide();
      });
      scroller.addEventListener("click", (ev) => {
        const tog = ev.target.closest("[data-toggle]");
        if (tog) opts.onToggle(tog.dataset.toggle, tog.getAttribute("aria-expanded") === "false");
      });
      // Double-click jumps to the row in the raw table (single click stays put while presenting).
      scroller.addEventListener("dblclick", (ev) => {
        const n = ev.target.closest("[data-id]");
        if (n && !ev.target.closest("[data-toggle]")) opts.onPick(n.dataset.id || n.getAttribute("data-id"));
      });
    },

    tipHtml(t, sched, pfam, cd) {
      if (!t) return "";
      const r = sched.rows.get(t.id) || {};
      const wbs = sched.wbs.get(t.id);
      const build = t._build ? `<div class="tip-row"><span>Build</span><b>${U.esc(t._build)}</b></div>` : "";
      if (t.type === "lane") {
        return `<div class="tip-title">${U.esc(t.build)} · ${U.esc(t.name)}</div>
          <div class="tip-row"><span>期間（不含沿用段）</span><b>${U.fmt(r.start, "full")} → ${U.fmt(r.end, "full")}</b></div>`;
      }
      if (t.type === "section") {
        const note = t._inherited
          ? `<div class="tip-notes">2nd build 的前段，預設收合（沿用 1st）。${t._total ? `${t._copied}/${t._total} 項任務與其他分頁日期完全相同。` : ""}</div>`
          : "";
        return `<div class="tip-title">${U.esc(wbs)} ${U.esc(t.name)}</div>${build}
          <div class="tip-row"><span>期間</span><b>${U.fmt(r.start, "full")} → ${U.fmt(r.end, "full")}</b></div>${note}${CloudDiff.tipHtml(cd)}`;
      }
      const g = U.OWNER_GROUPS.find((x) => x.key === U.ownerGroup(t.lead));
      let rule = "未排程";
      if (t.startMode === "manual") rule = "固定日期";
      if (t.startMode === "dep") {
        const p = pfam.tasks.find((x) => x.id === t.pred);
        rule = p ? `${sched.wbs.get(p.id)} ${U.esc(p.name)} 完成後 ${t.lag >= 0 ? "+" : ""}${t.lag} 工作天` : "前置任務遺失";
      }
      const base = t.base && (t.base.start || t.base.end)
        ? `<div class="tip-row"><span>基準</span><b>${U.esc(t.base.start || "—")} → ${U.esc(t.base.end || "—")}</b></div>` : "";
      const be = t.base && E.toDay(t.base.end);
      const delta = be != null && r.end != null && be !== r.end
        ? `<div class="tip-row"><span>相對基準</span><b class="${r.end > be ? "late" : "early"}">${r.end > be ? "▲ 延後" : "▼ 提前"} ${Math.abs(r.end - be)} 天</b></div>` : "";
      return `<div class="tip-title">${U.esc(wbs)} ${U.esc(t.name)}</div>${build}
        <div class="tip-row"><span>負責</span><b><i class="sw s${g ? g.slot : 0}"></i>${U.esc(t.lead || "未指定")}</b></div>
        <div class="tip-row"><span>日期</span><b>${U.fmt(r.start, "full") || "—"} → ${U.fmt(r.end, "full") || "—"}</b></div>
        <div class="tip-row"><span>工期</span><b>${t.workdays != null ? t.workdays + " 工作天" : "—"}${r.days ? ` · ${r.days} 日曆天` : ""}</b></div>
        <div class="tip-row"><span>開始規則</span><b>${rule}</b></div>
        ${base}${delta}${CloudDiff.tipHtml(cd)}
        ${t.pct ? `<div class="tip-row"><span>完成</span><b>${t.pct}%</b></div>` : ""}
        ${r.error ? `<div class="tip-err">⚠ ${U.esc(r.error)}</div>` : ""}
        ${t.notes ? `<div class="tip-notes">${U.esc(t.notes.length > 220 ? t.notes.slice(0, 220) + "…" : t.notes)}</div>` : ""}`;
    },
  };

  window.Gantt = Gantt;
})();
