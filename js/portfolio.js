/*
 * Portfolio list. Two views:
 *   group - 1st + 2nd builds of the same PFAM share one row (two stacked lanes), expandable to the sheets
 *   sheet - every Excel sheet on its own row
 */
(function () {
  const E = window.Engine;
  const FILTER_GROUPS = [
    ["gen", "Gen"],
    ["site", "廠區"],
    ["phase", "階段"],
    ["sku", "SKU"],
  ];

  function monthStart(day) {
    const d = new Date(day * 86400000);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000);
  }
  function addMonths(day, n) {
    const d = new Date(day * 86400000);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 86400000);
  }

  function passes(p, tg) {
    const ui = Store.ui;
    const q = ui.search.trim().toLowerCase();
    if (q && !(p.sheet + " " + p.title).toLowerCase().includes(q)) return false;
    for (const [k] of FILTER_GROUPS) {
      const sel = ui.filters[k];
      if (sel && sel.length && !sel.includes(tg[k])) return false;
    }
    return true;
  }

  function sheetItem(p, today) {
    const tg = U.tags(p);
    const s = Store.sched(p);
    const key = U.keyDates(p, s);
    let errors = 0;
    for (const r of s.rows.values()) if (r.error) errors++;
    return { kind: "pfam", id: p.id, p, tags: tg, sched: s, span: s.span, key, errors, phase: U.phaseOf(key, s.span, today) };
  }

  function groupItem(g, today) {
    const sum = Groups.summary(g);
    const members = g.members.map((m) => ({ ...sheetItem(m.p, today), build: m.build }));
    const tags = { ...members[0].tags, phase: g.members.map((m) => m.build).join(" + ") };
    const errors = members.reduce((a, m) => a + m.errors, 0);
    const lanes = sum.perBuild.map((b) => ({ build: b.build, span: b.span, key: b.key }));
    return { kind: "group", id: g.id, g, name: g.name, tags, members, span: sum.sched.span, key: sum.key, lanes, errors, phase: U.phaseOf(sum.key, sum.sched.span, today) };
  }

  /** Phase segments (prep -> build/test -> shipping -> tail) and markers for one lane, clipped at r0. */
  function laneHtml(span, key, pct, cls, r0) {
    const s = span.start;
    const e = span.end;
    if (s == null || e == null || e < r0) return "";
    const b = key.build ? key.build.start : null;
    const etd = key.etd ? key.etd.start : null;
    const dock = key.dock ? key.dock.start : null;
    const segs = [];
    const seg = (a, z, c) => {
      if (a == null || z == null || z < a || z < r0) return;
      segs.push({ a: Math.max(a, r0), z, c: a < r0 ? c + " cut" : c });
    };
    seg(s, (b ?? etd ?? dock ?? e + 1) - 1, "ph-prep");
    if (b != null) seg(Math.max(b, s), (etd ?? dock ?? e + 1) - 1, "ph-build");
    if (etd != null) seg(etd, (dock ?? e + 1) - 1, "ph-ship");
    if (dock != null && e > dock) seg(dock + 1, e, "ph-tail");
    let html = "";
    segs.forEach((g, i) => {
      const c = `${g.c}${i === 0 ? " first" : ""}${i === segs.length - 1 ? " last" : ""}`;
      html += `<i class="pf-seg ${c} ${cls || ""}" style="left:${pct(g.a)};width:calc(${pct(g.z + 1)} - ${pct(g.a)})"></i>`;
    });
    if (etd != null && etd >= r0) html += `<i class="pf-etd ${cls || ""}" style="left:${pct(etd)}"></i>`;
    if (dock != null && dock >= r0) html += `<i class="pf-dock ${cls || ""}" style="left:${pct(dock)}"></i>`;
    return html;
  }

  const Portfolio = {
    /** Top-level items for the current view, after filters and sort. */
    items() {
      const ui = Store.ui;
      const today = U.today();
      let out = [];
      if (ui.pfView === "group") {
        for (const e of Groups.entries(ui.showHidden)) {
          if (e.kind === "pfam") {
            if (passes(e.p, U.tags(e.p))) out.push(sheetItem(e.p, today));
          } else if (e.members.some((m) => passes(m.p, U.tags(m.p)))) out.push(groupItem(e, today));
        }
      } else {
        for (const p of Store.data.pfams) {
          if (p.hidden && !ui.showHidden) continue;
          if (passes(p, U.tags(p))) out.push(sheetItem(p, today));
        }
      }
      const buildDay = (it) => (it.key.build ? it.key.build.start : it.span.start) ?? 1e9;
      if (ui.sort === "start") out.sort((a, b) => buildDay(a) - buildDay(b));
      if (ui.sort === "dock") out.sort((a, b) => ((a.key.dock && a.key.dock.start) ?? 1e9) - ((b.key.dock && b.key.dock.start) ?? 1e9));
      return out;
    },

    renderFilters(root) {
      const ui = Store.ui;
      const pool = Store.data.pfams.filter((p) => !p.hidden || ui.showHidden).map((p) => U.tags(p));
      const groups = FILTER_GROUPS.map(([k, label]) => {
        const values = [...new Set(pool.map((t) => t[k]).filter(Boolean))].sort();
        if (values.length < 2) return "";
        const sel = ui.filters[k] || [];
        const all = `<button class="chip all${sel.length ? "" : " on"}" data-fk="${k}" data-fv="" aria-pressed="${!sel.length}">全部</button>`;
        return `<div class="chip-group" role="group" aria-label="${label}"><span class="chip-label">${label}</span>${all}${values
          .map((v) => `<button class="chip${sel.includes(v) ? " on" : ""}" data-fk="${k}" data-fv="${U.esc(v)}" aria-pressed="${sel.includes(v)}">${U.esc(v)}</button>`)
          .join("")}</div>`;
      }).join("");
      const hiddenCount = Store.data.pfams.filter((p) => p.hidden).length;
      const filtered = Object.values(ui.filters).some((a) => a && a.length) || ui.search;
      root.innerHTML = `
        <div class="filter-row">
          <div class="seg view-seg" role="group" aria-label="總覽檢視">
            <button type="button" data-pfview="group" aria-pressed="${ui.pfView === "group"}" title="同一個 PFAM 的 1st + 2nd build 合併成一列">PFAM 群組</button>
            <button type="button" data-pfview="sheet" aria-pressed="${ui.pfView === "sheet"}" title="每個 Excel 分頁一列">Excel 分頁</button>
          </div>
          <label class="search"><span aria-hidden="true">⌕</span><input id="pfSearch" type="search" placeholder="搜尋 PFAM / 標題" value="${U.esc(ui.search)}" aria-label="搜尋 PFAM"></label>
        </div>
        ${groups ? `<div class="filter-box">
          <div class="filter-box-head"><b>⏷ 篩選</b><span>點選即套用，同一類可複選</span>${filtered ? `<button class="link" id="pfClear">✕ 清除篩選</button>` : ""}</div>
          <div class="filter-groups">${groups}</div>
        </div>` : ""}
        <div class="filter-row sub">
          <label class="sel">排序
            <select id="pfSort">
              <option value="order"${ui.sort === "order" ? " selected" : ""}>Excel 分頁順序</option>
              <option value="start"${ui.sort === "start" ? " selected" : ""}>L10 Build 日</option>
              <option value="dock"${ui.sort === "dock" ? " selected" : ""}>Dock 日</option>
            </select>
          </label>
          <label class="toggle"><input type="checkbox" id="pfFull"${ui.pfFullRange ? " checked" : ""}> 顯示完整時間軸<span id="pfRangeNote" class="muted"></span></label>
          ${hiddenCount ? `<label class="toggle"><input type="checkbox" id="pfHidden"${ui.showHidden ? " checked" : ""}> 顯示已封存分頁（${hiddenCount} 個）</label>` : ""}
          <span class="legend">
            <span><i class="lg-ph ph-prep"></i>準備期</span>
            <span class="lg-strong"><i class="lg-ph ph-build"></i>建置測試</span>
            <span><i class="lg-ph ph-ship"></i>出貨運輸</span>
            <span><i class="lg-etd"></i>ETD</span>
            <span><i class="lg-dock"></i>Dock</span>
            <span><i class="lg-today"></i>今天</span>
          </span>
        </div>`;
    },

    render(root) {
      const items = this.items();
      const ui = Store.ui;
      const countEl = U.$("#pfCount");
      if (countEl) {
        const sheets = items.reduce((a, it) => a + (it.kind === "group" ? it.members.length : 1), 0);
        countEl.textContent = ui.pfView === "group" ? `${items.length} 列 · ${sheets} 個分頁` : `${items.length} 個分頁`;
      }
      this.renderSummary(items);

      if (!items.length) {
        root.innerHTML = `<div class="empty-note">沒有符合篩選條件的 PFAM。</div>`;
        return;
      }

      let min = Infinity;
      let max = -Infinity;
      const spans = [];
      for (const it of items) {
        spans.push(it.span);
        if (it.kind === "group" && ui.pfExpanded[it.id]) for (const m of it.members) spans.push(m.span);
      }
      for (const sp of spans) {
        if (sp.start != null) min = Math.min(min, sp.start);
        if (sp.end != null) max = Math.max(max, sp.end);
      }
      const today = U.today();
      if (!isFinite(min)) {
        min = today;
        max = min + 90;
      }
      // Past history is noise here: unless asked for the full range, start at most 2 months before today.
      const cutoff = addMonths(monthStart(today), -2);
      const r0 = ui.pfFullRange ? monthStart(min) : Math.max(monthStart(min), cutoff);
      const r1 = Math.max(addMonths(max, 1), addMonths(r0, 3));
      const span = r1 - r0;
      const pct = (d) => (((d - r0) / span) * 100).toFixed(3) + "%";

      const tlWidth = Math.max(200, (root.clientWidth || 1000) - 600);
      const pxPerMonth = (tlWidth / span) * 30.4;
      const every = pxPerMonth > 44 ? 1 : pxPerMonth > 22 ? 3 : 6;
      let ticks = "";
      let bands = "";
      for (let m = r0; m < r1; m = addMonths(m, 1)) {
        const d = new Date(m * 86400000);
        const mon = d.getUTCMonth();
        const yearStart = mon === 0 || m === r0;
        if (mon % every === 0 || yearStart) {
          const label = yearStart ? `${d.getUTCFullYear()}/${mon + 1}` : `${mon + 1}月`;
          ticks += `<span class="tick${mon === 0 ? " year" : ""}" style="left:${pct(m)}">${label}</span>`;
        }
        if (Math.floor(mon / 3) % 2 === 1 && mon % 3 === 0) {
          const qEnd = Math.min(addMonths(m, 3), r1);
          bands += `<i class="pf-band" style="left:${pct(m)};width:calc(${pct(qEnd)} - ${pct(m)})"></i>`;
        }
      }
      const todayMark = today >= r0 && today <= r1 ? `<i class="pf-today" style="left:${pct(today)}"><b>今天</b></i>` : "";
      const ctx = { pct, today, r0, r1, bands };
      const rangeNote = U.$("#pfRangeNote");
      if (rangeNote) rangeNote.textContent = ui.pfFullRange ? "" : `（時間軸從 ${U.fmt(r0).slice(0, 7)} 開始）`;

      const byGen = new Map();
      for (const it of items) {
        const k = ui.sort === "order" ? it.tags.gen : "";
        if (!byGen.has(k)) byGen.set(k, []);
        byGen.get(k).push(it);
      }

      let html = `<div class="pf-table" role="list">
        <div class="pf-head" aria-hidden="true">
          <div class="c-name">PFAM</div>
          <div class="c-date"><i class="dot ph-build"></i>L10 Build</div>
          <div class="c-date"><i class="dot ph-ship"></i>ETD</div>
          <div class="c-date"><i class="dot dock"></i>Dock</div>
          <div class="c-tl"><div class="pf-axis">${ticks}${todayMark}</div></div>
        </div>`;
      for (const [g, list] of byGen) {
        if (g) html += `<div class="pf-group gen-${U.esc(g).replace(/\./g, "")}"><span class="gen-pill">Gen ${U.esc(g)}</span><span class="muted">${list.length} 列</span></div>`;
        for (const it of list) {
          if (it.kind === "group") {
            html += this.groupRowHtml(it, ctx);
            if (ui.pfExpanded[it.id]) for (const m of it.members) html += this.rowHtml(m, ctx, true);
          } else html += this.rowHtml(it, ctx, false);
        }
      }
      html += `</div>`;
      root.innerHTML = html;
    },

    renderSummary(items) {
      const el = U.$("#pfSummary");
      if (!el) return;
      const late = items.filter((it) => it.key.dockDelta > 0).length;
      el.innerHTML = late ? `<span class="sum late-sum"><b>${late}</b>Dock 較基準延後</span>` : "";
    },

    /** Second line of a row: the SKU (the thing to notice), site, and build for single sheets. */
    tagsHtml(it) {
      const { tags } = it;
      const sku = tags.sku ? `<span class="tag sku">${U.esc(tags.sku)}</span>` : "";
      const site = tags.site ? `<span class="tag site-${tags.site}">${U.esc(tags.site)}</span>` : "";
      // Groups show "1st + 2nd" next to their name instead.
      const ph = it.kind !== "group" && tags.phase && tags.phase !== "其他" ? `<span class="tag">${U.esc(tags.phase)}</span>` : "";
      return `${sku}${site}${ph}`;
    },

    rowHtml(it, ctx, member) {
      const { p, key } = it;
      const sel = Store.ui.selectedId === p.id;
      const dockDelta = key.dockDelta
        ? `<span class="delta ${key.dockDelta > 0 ? "late" : "early"}" title="相對基準 ${U.signedDays(key.dockDelta)}">${key.dockDelta > 0 ? "▲" : "▼"}${Math.abs(key.dockDelta)}d</span>`
        : "";
      const todayLine = ctx.today >= ctx.r0 && ctx.today <= ctx.r1 ? `<i class="pf-today" style="left:${ctx.pct(ctx.today)}"></i>` : "";
      const lead = member ? `<span class="build-pill">${U.esc(it.build)}</span>` : "";
      return `<div class="pf-row${member ? " member" : ""}${sel ? " selected" : ""}${p.hidden ? " is-hidden" : ""}" role="listitem" tabindex="0" data-pfam="${p.id}" aria-current="${sel}">
        <div class="c-name">
          <div class="nm" title="${U.esc(p.sheet)}">${lead}${U.esc(p.sheet)}${it.errors ? `<span class="warn" title="${it.errors} 個任務有排程錯誤">⚠</span>` : ""}${p.hidden ? `<span class="tag ghost">隱藏</span>` : ""}</div>
          ${member ? "" : `<div class="tg">${this.tagsHtml(it)}</div>`}
        </div>
        <div class="c-date">${key.build ? U.fmt(key.build.start) : "—"}</div>
        <div class="c-date">${key.etd ? U.fmt(key.etd.start) : "—"}</div>
        <div class="c-date strong">${key.dock ? U.fmt(key.dock.start) : "—"}${dockDelta}</div>
        <div class="c-tl">${ctx.bands}${laneHtml(it.span, key, ctx.pct, "", ctx.r0)}${todayLine}</div>
      </div>`;
    },

    groupRowHtml(it, ctx) {
      const ui = Store.ui;
      const sel = ui.selectedId === it.id;
      const inside = it.members.some((m) => m.p.id === ui.selectedId);
      const open = !!ui.pfExpanded[it.id];
      const stack = (fn) => it.lanes.map((l) => `<div class="stk"><span class="bl">${U.esc(l.build)}</span>${fn(l)}</div>`).join("");
      const d = (x) => (x ? U.fmt(x.start, "yy") : "—");
      const deltaOf = (l) =>
        l.key.dockDelta ? ` <span class="delta-i ${l.key.dockDelta > 0 ? "late" : "early"}">${l.key.dockDelta > 0 ? "▲" : "▼"}${Math.abs(l.key.dockDelta)}d</span>` : "";
      const todayLine = ctx.today >= ctx.r0 && ctx.today <= ctx.r1 ? `<i class="pf-today" style="left:${ctx.pct(ctx.today)}"></i>` : "";
      const lanes = it.lanes.map((l, i) => laneHtml(l.span, l.key, ctx.pct, `lane${i}`, ctx.r0)).join("");
      const laneTags = it.lanes
        .map((l, i) => (l.span.start != null && l.span.end >= ctx.r0 ? `<span class="lane-tag lane${i}${l.span.start < ctx.r0 ? " at-edge" : ""}" style="left:${ctx.pct(Math.max(l.span.start, ctx.r0))}">${U.esc(l.build)}</span>` : ""))
        .join("");
      return `<div class="pf-row grp${sel ? " selected" : ""}${inside ? " has-selected" : ""}" role="listitem" tabindex="0" data-pfam="${it.id}" aria-current="${sel}" aria-expanded="${open}">
        <div class="c-name">
          <div class="nm"><button class="caret pf-caret" data-expand="${it.id}" aria-label="${open ? "收合" : "展開"}分頁" aria-expanded="${open}">${open ? "▾" : "▸"}</button>${U.esc(it.name)}<span class="tag builds" title="${it.members.length} 個 Excel 分頁合併：${U.esc(it.members.map((m) => m.p.sheet).join("、"))}">${U.esc(it.tags.phase)}</span>${it.errors ? `<span class="warn" title="${it.errors} 個任務有排程錯誤">⚠</span>` : ""}</div>
          <div class="tg">${this.tagsHtml(it)}</div>
        </div>
        <div class="c-date stack">${stack((l) => d(l.key.build))}</div>
        <div class="c-date stack">${stack((l) => d(l.key.etd))}</div>
        <div class="c-date stack strong">${stack((l) => d(l.key.dock) + deltaOf(l))}</div>
        <div class="c-tl lanes">${ctx.bands}${lanes}${laneTags}${todayLine}</div>
      </div>`;
    },
  };

  window.Portfolio = Portfolio;
})();
