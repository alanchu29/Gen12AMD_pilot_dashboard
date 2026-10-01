/*
 * Resource load (人力負載): every task whose LEAD names one of the checked roles (e.g. STE, TE), across all PFAMs,
 * on one timeline under a daily count of how many PFAMs need that role at the same time.
 * A PFAM is a portfolio group (1st + 2nd builds merged) or a standalone sheet. Load on a day = number of PFAMs with at
 * least one matching task running (start <= day <= end): several tasks of one PFAM on the same day count once.
 * Archived sheets never count; 2nd-build sections that repeat the 1st build ("沿用 1st", same rule as the merged Gantt)
 * are left out unless asked for, so they are not counted twice.
 */
(function () {
  const E = window.Engine;
  const ROW_H = 28; // must match .g-row height in app.css
  const BAR_H = 12;
  const AXIS_H = 46; // what Gantt.drawAxis draws
  const CHART_H = 132;
  const PLOT_TOP = 18;
  const PLOT_BOT = CHART_H - 8;
  const ZOOM = {
    day: { ppd: 22, pad: 5 },
    week: { ppd: 7, pad: 14 },
    month: { ppd: 2.4, pad: 31 },
  };
  const FILTERS = [
    ["gen", "Gen"],
    ["site", "廠區"],
    ["phase", "階段"],
    ["sku", "SKU"],
  ];
  const TIP_TASKS = 14;
  const NAME_COMBO = "依任務名稱"; // legend entry for tasks picked by name rather than by role
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

  let opts = null; // { tip, onOpen } from App
  let pin = null; // clicked day: its tasks are highlighted
  let pinOnly = false;
  let cur = null; // what the last render drew, for the event handlers

  function passes(tg) {
    const f = Store.ui.loadFilters;
    return FILTERS.every(([k]) => !f[k] || !f[k].length || f[k].includes(tg[k]));
  }

  /** PFAMs as the portfolio groups them: 1st + 2nd builds merged, other sheets on their own. */
  function pfamUnits() {
    return Groups.entries(false).map((e) =>
      e.kind === "group"
        ? { id: e.id, name: e.name, members: e.members.map((m, i) => ({ p: m.p, build: m.build, later: i > 0 })) }
        : { id: e.p.id, name: Groups.label(e.p), members: [{ p: e.p, build: null, later: false }] }
    );
  }

  /** Matching tasks per PFAM and the daily load (PFAMs with a matching task running that day). */
  function collect() {
    const ui = Store.ui;
    const roles = ui.loadRoles;
    const names = ui.loadTaskNames.map((k) => k.toLowerCase());
    const units = [];
    const combos = [];
    let skipped = 0;
    for (const u of pfamUnits()) {
      const tasks = [];
      const sites = new Set();
      for (const mem of u.members) {
        const p = mem.p;
        const tags = U.tags(p);
        if (!passes(tags)) continue;
        const s = Store.sched(p);
        let inherited = false;
        let n = 0;
        for (const t of p.tasks) {
          if (t.type === "section") {
            inherited = mem.later && !/volume/i.test(t.name);
            continue;
          }
          if (t.type !== "task") continue;
          const hit = U.matchRoles(t.lead, roles);
          // Tasks named in "另計任務名稱" count too, whoever leads them.
          const nameKey = hit.length ? null : names.find((k) => String(t.name).toLowerCase().includes(k));
          if (!hit.length && !nameKey) continue;
          if (inherited && !ui.loadInherited) {
            skipped++;
            continue;
          }
          const r = s.rows.get(t.id);
          if (!r || (r.start == null && r.end == null)) continue;
          const a = r.start != null ? r.start : r.end;
          const b = r.end != null ? r.end : r.start;
          if (b < a) continue; // "結束早於開始": no meaningful span
          const combo = hit.length ? hit.join(" + ") : NAME_COMBO;
          if (!combos.includes(combo)) combos.push(combo);
          const byName = nameKey ? ui.loadTaskNames[names.indexOf(nameKey)] : null;
          tasks.push({ key: p.id + ":" + t.id, unit: u, p, build: mem.build, t, a, b, hit, byName, combo, single: a === b && (Number(t.workdays) || 0) <= 1 });
          n++;
        }
        if (n && tags.site) sites.add(tags.site);
      }
      if (tasks.length) units.push({ ...u, tasks, sites: [...sites].sort() });
    }
    // Legend order: single roles in the order typed, then combinations, then tasks picked by name.
    const rank = (c) => (c === NAME_COMBO ? 1e6 : c.split(" + ").length * 100 + roles.indexOf(c.split(" + ")[0]));
    combos.sort((x, y) => rank(x) - rank(y));

    const all = units.flatMap((u) => u.tasks);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of all) {
      lo = Math.min(lo, x.a);
      hi = Math.max(hi, x.b);
    }
    // One PFAM counts once per day however many of its tasks overlap: add its merged spans, not its tasks.
    const load = new Int32Array(all.length ? hi - lo + 2 : 0);
    for (const u of units) {
      u.spans = cover(u.tasks);
      for (const [a, b] of u.spans) {
        load[a - lo]++;
        load[b - lo + 1]--;
      }
    }
    for (let i = 1; i < load.length; i++) load[i] += load[i - 1];
    const at = (day) => (day < lo || day > hi ? 0 : load[day - lo]);
    return { units, all, lo, hi, at, combos, skipped };
  }

  /** Consecutive day ranges in [from, to] whose load passes test. */
  function runs(m, from, to, test) {
    const out = [];
    let start = null;
    for (let d = from; d <= to + 1; d++) {
      const ok = d <= to && test(m.at(d));
      if (ok && start == null) start = d;
      if (!ok && start != null) {
        out.push([start, d - 1]);
        start = null;
      }
    }
    return out;
  }

  /** Merge task spans into covered ranges (the strip on a PFAM's header row). */
  function cover(tasks) {
    const spans = tasks.map((x) => [x.a, x.b]).sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
      else out.push([s[0], s[1]]);
    }
    return out;
  }

  function kpi(label, value, sub, cls) {
    return `<div class="kpi ${cls || ""}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  }

  const Load = {
    bind(o) {
      opts = o;
      const $ = U.$;
      $("#ldRoles").addEventListener("change", (ev) => {
        pin = null;
        pinOnly = false;
        Store.setUi({ loadRoles: U.parseRoles(ev.target.value) });
      });
      $("#ldNames").addEventListener("change", (ev) => {
        pin = null;
        pinOnly = false;
        // Names contain spaces, so only commas / 、 / ; separate them.
        const list = ev.target.value.split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean);
        Store.setUi({ loadTaskNames: [...new Set(list)] });
      });
      $("#ldCap").addEventListener(
        "input",
        U.debounce((ev) => {
          const v = parseInt(ev.target.value, 10);
          Store.setUi({ loadCap: v > 0 ? v : null });
        }, 250)
      );
      document.querySelectorAll("[data-ldzoom]").forEach((b) => b.addEventListener("click", () => Store.setUi({ loadZoom: b.dataset.ldzoom })));
      $("#ldFull").addEventListener("change", (ev) => Store.setUi({ loadFull: ev.target.checked }));
      $("#ldInh").addEventListener("change", (ev) => Store.setUi({ loadInherited: ev.target.checked }));
      $("#ldToday").addEventListener("click", () => this.scrollToDay && this.scrollToDay(U.today()));
      $("#ldCollapse").addEventListener("click", () => {
        if (!cur) return;
        const ids = cur.unitIds;
        const c = Store.ui.loadCollapsed;
        const allCollapsed = ids.every((id) => c[id]);
        Store.setUi({ loadCollapsed: allCollapsed ? {} : Object.fromEntries(ids.map((id) => [id, true])) });
      });

      $("#ldFilters").addEventListener("click", (ev) => {
        if (ev.target.closest("[data-lfclear]")) {
          pin = null;
          Store.setUi({ loadFilters: { gen: [], site: [], phase: [], sku: [] } });
          return;
        }
        const c = ev.target.closest("[data-lfk]");
        if (!c) return;
        const f = JSON.parse(JSON.stringify(Store.ui.loadFilters));
        const arr = f[c.dataset.lfk] || [];
        const v = c.dataset.lfv;
        f[c.dataset.lfk] = !v ? [] : arr.includes(v) ? arr.filter((x) => x !== v) : arr.concat(v);
        Store.setUi({ loadFilters: f });
      });

      $("#ldBar").addEventListener("change", (ev) => {
        if (ev.target.dataset.ld === "pinOnly") {
          pinOnly = ev.target.checked;
          this.render();
        }
      });
      $("#ldBar").addEventListener("click", (ev) => {
        if (ev.target.closest('[data-ld="unpin"]')) {
          pin = null;
          pinOnly = false;
          this.render();
        }
      });

      const root = $("#ldChart");
      let hot = null;
      const setHot = (id) => {
        if (hot === id) return;
        if (hot) root.querySelectorAll(`[data-id="${hot}"]`).forEach((n) => n.classList.remove("hot"));
        hot = id;
        if (hot) root.querySelectorAll(`[data-id="${hot}"]`).forEach((n) => n.classList.add("hot"));
      };
      const dayAt = (ev, hit) => cur.r0 + Math.floor((ev.clientX - hit.getBoundingClientRect().left) / cur.ppd);
      const guide = (day) => {
        for (const ln of cur.guides) {
          if (day == null) ln.setAttribute("visibility", "hidden");
          else {
            const gx = cur.x(day) + cur.ppd / 2;
            ln.setAttribute("x1", gx);
            ln.setAttribute("x2", gx);
            ln.setAttribute("visibility", "visible");
          }
        }
      };
      root.addEventListener("mousemove", (ev) => {
        if (!cur) return;
        const hit = ev.target.closest(".ld-hit");
        if (hit) {
          const day = dayAt(ev, hit);
          setHot(null);
          guide(day);
          opts.tip.show(this.dayTip(day), ev);
          return;
        }
        guide(null);
        const n = ev.target.closest("[data-id]");
        const id = n ? n.getAttribute("data-id") : null;
        setHot(id);
        if (id && cur.byKey.has(id)) opts.tip.show(this.taskTip(cur.byKey.get(id)), ev);
        else opts.tip.hide();
      });
      root.addEventListener("mouseleave", () => {
        if (cur) guide(null);
        setHot(null);
        opts.tip.hide();
      });
      root.addEventListener("click", (ev) => {
        const tog = ev.target.closest("[data-ldtoggle]");
        if (tog) {
          const id = tog.dataset.ldtoggle;
          Store.setUi({ loadCollapsed: Object.assign({}, Store.ui.loadCollapsed, { [id]: !Store.ui.loadCollapsed[id] }) });
          return;
        }
        const hit = ev.target.closest(".ld-hit");
        if (hit && cur) {
          const day = dayAt(ev, hit);
          pin = pin === day ? null : day;
          if (pin == null) pinOnly = false;
          opts.tip.hide();
          this.render();
        }
      });
      root.addEventListener("dblclick", (ev) => {
        const n = ev.target.closest("[data-id]");
        const x = n && cur && cur.byKey.get(n.getAttribute("data-id"));
        if (x) opts.onOpen(x.unit.id, x.p.id, x.t.id);
      });
    },

    syncControls() {
      const ui = Store.ui;
      const $ = U.$;
      if (document.activeElement !== $("#ldRoles")) $("#ldRoles").value = ui.loadRoles.join(", ");
      if (document.activeElement !== $("#ldNames")) $("#ldNames").value = ui.loadTaskNames.join(", ");
      if (document.activeElement !== $("#ldCap")) $("#ldCap").value = ui.loadCap > 0 ? ui.loadCap : "";
      document.querySelectorAll("[data-ldzoom]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ldzoom === ui.loadZoom)));
      $("#ldFull").checked = ui.loadFull;
      $("#ldInh").checked = ui.loadInherited;
    },

    renderFilters() {
      const f = Store.ui.loadFilters;
      const pool = Store.data.pfams.filter((p) => !p.hidden).map((p) => U.tags(p));
      const groups = FILTERS.map(([k, label]) => {
        const values = [...new Set(pool.map((t) => t[k]).filter(Boolean))].sort();
        if (values.length < 2) return "";
        const sel = f[k] || [];
        const all = `<button class="chip all${sel.length ? "" : " on"}" data-lfk="${k}" data-lfv="" aria-pressed="${!sel.length}">全部</button>`;
        return `<div class="chip-group" role="group" aria-label="${label}"><span class="chip-label">${label}</span>${all}${values
          .map((v) => `<button class="chip${sel.includes(v) ? " on" : ""}" data-lfk="${k}" data-lfv="${U.esc(v)}" aria-pressed="${sel.includes(v)}">${U.esc(v)}</button>`)
          .join("")}</div>`;
      }).join("");
      const any = FILTERS.some(([k]) => f[k] && f[k].length);
      U.$("#ldFilters").innerHTML = groups
        ? `<div class="ld-filters"><span class="ld-flabel">PFAM 範圍</span>${groups}${any ? `<button class="link" data-lfclear>✕ 清除篩選</button>` : `<span class="muted">預設計入全部 PFAM</span>`}</div>`
        : "";
    },

    render() {
      const $ = U.$;
      const root = $("#ldChart");
      const ui = Store.ui;
      this.syncControls();
      this.renderFilters();
      const roles = ui.loadRoles;
      const names = ui.loadTaskNames;
      const what = [roles.join(" / "), names.length ? "指定任務" : ""].filter(Boolean).join(" + ");
      const cap = Number(ui.loadCap) > 0 ? Number(ui.loadCap) : null;
      const today = U.today();
      const m = collect();

      if (!m.all.length) {
        cur = null;
        $("#ldCount").textContent = "";
        $("#ldKpis").innerHTML = "";
        $("#ldBar").innerHTML = "";
        $("#ldRangeNote").textContent = "";
        const filtered = FILTERS.some(([k]) => ui.loadFilters[k] && ui.loadFilters[k].length);
        root.innerHTML = `<div class="empty-note">${
          !roles.length && !names.length
            ? "請在上方輸入要檢查的人力類別（例如 STE, TE）或任務名稱"
            : `沒有符合的任務（負責欄含 ${U.esc(roles.join(" / ") || "—")}${names.length ? `，或名稱含「${U.esc(names.join("、"))}」` : ""}）${filtered ? "，或都被 PFAM 範圍篩掉了" : ""}。`
        }</div>`;
        return;
      }

      // ---- time range: like the portfolio, start 2 months before today unless the full range is asked for
      const zoomKey = ZOOM[ui.loadZoom] ? ui.loadZoom : "week";
      const zoom = ZOOM[zoomKey];
      const ppd = zoom.ppd;
      const cutoff = addMonths(monthStart(today), -2);
      const clipped = !ui.loadFull && m.hi >= cutoff && m.lo < cutoff;
      let r0 = clipped ? cutoff : m.lo;
      let r1 = m.hi + zoom.pad * 2;
      if (zoomKey === "month") {
        r0 = monthStart(r0);
        r1 = addMonths(r1, 1) - 1;
      } else {
        if (!clipped) r0 -= zoom.pad;
        r0 -= (E.weekday(r0) + 6) % 7; // back to Monday
      }
      const W = Math.ceil((r1 - r0 + 1) * ppd);
      const x = (day) => (day - r0) * ppd;

      // ---- rows: PFAMs ordered by their first visible task
      const active = (t, d) => t.a <= d && d <= t.b;
      const shown = [];
      let before = 0;
      let listed = 0;
      let listedUnits = 0;
      for (const u of m.units) {
        let tasks = u.tasks.filter((t) => t.b >= r0);
        before += u.tasks.length - tasks.length;
        listed += tasks.length;
        if (tasks.length) listedUnits++;
        if (pin != null && pinOnly) tasks = tasks.filter((t) => active(t, pin));
        if (tasks.length) shown.push({ ...u, tasks, first: Math.min(...tasks.map((t) => t.a)) });
      }
      shown.sort((p, q) => p.first - q.first);
      const rows = [];
      for (const u of shown) {
        const collapsed = !!ui.loadCollapsed[u.id];
        rows.push({ unit: u, collapsed });
        if (!collapsed) u.tasks.forEach((t, i) => rows.push({ task: t, zebra: i % 2 === 1 }));
      }
      $("#ldCount").textContent = `${listedUnits} 個 PFAM · ${listed} 個 task`;
      $("#ldRangeNote").textContent = clipped
        ? `（時間軸從 ${U.fmt(cutoff).slice(0, 7)} 開始${before ? `，之前已結束的 ${before} 個 task 未列出` : ""}）`
        : "";

      // ---- KPIs
      let peak = 0;
      let peakDay = null;
      for (let d = Math.max(r0, m.lo); d <= m.hi; d++) {
        const c = m.at(d);
        if (c > peak) {
          peak = c;
          peakDay = d;
        }
      }
      let peakEnd = peakDay;
      while (peakEnd != null && m.at(peakEnd + 1) === peak) peakEnd++;
      let overDays = 0;
      let firstOver = null;
      if (cap) {
        for (let d = Math.max(today, m.lo); d <= m.hi; d++) {
          if (m.at(d) > cap && E.weekday(d) % 6 !== 0) {
            overDays++;
            if (firstOver == null) firstOver = d;
          }
        }
      }
      const over = cap ? runs(m, Math.max(r0, m.lo), m.hi, (c) => c > cap) : [];
      const nowC = m.at(today);
      $("#ldKpis").innerHTML =
        kpi(
          `用到 ${U.esc(what)} 的 PFAM`,
          `${listedUnits} 個`,
          `${listed} 個 task${m.skipped ? `・未計 2nd 沿用段 ${m.skipped} 個` : ""}`,
          "k-span"
        ) +
        kpi(
          "今天同時進行的 PFAM",
          `${nowC} 個`,
          cap ? (nowC > cap ? `<span class="late">超過上限 ${nowC - cap} 個</span>` : `上限 ${cap}`) : "未設定上限",
          cap && nowC > cap ? "k-over" : "k-prep"
        ) +
        kpi(
          "峰值（時間軸內）",
          `${peak} 個`,
          peakDay != null ? `${U.fmt(peakDay)}${peakEnd > peakDay ? ` → ${U.fmt(peakEnd, "md")}` : ""}` : "",
          cap && peak > cap ? "k-over" : "k-span"
        ) +
        kpi(
          "超過上限（今天起）",
          cap ? `${overDays} 個工作日` : "—",
          cap ? (firstOver != null ? `最早 ${U.fmt(firstOver, "full")}` : "排程都在上限內") : "在上方填入負載上限",
          cap ? (overDays ? "k-over" : "k-ok") : ""
        );

      // ---- legend + pinned day
      const slotOf = (combo) => (m.combos.indexOf(combo) % 8) + 1;
      const pc = pin != null ? m.at(pin) : 0;
      $("#ldBar").innerHTML =
        (pin != null
          ? `<div class="ld-pin">📌 ${U.fmt(pin, "full")}：同時 <b>${pc}</b> 個 PFAM（${m.all.filter((t) => active(t, pin)).length} 個 task）${cap && pc > cap ? `<span class="late">超過上限 ${pc - cap}</span>` : ""}
              <label class="toggle"><input type="checkbox" data-ld="pinOnly"${pinOnly ? " checked" : ""}> 只看這天進行中的 task</label>
              <button type="button" class="link" data-ld="unpin">✕ 取消標記</button></div>`
          : `<span class="muted">點負載圖上的任一天，可標出當天進行中的 task</span>`) +
        `<span class="legend">${m.combos.map((c) => `<span><i class="sw s${slotOf(c)}"></i>${U.esc(c)}</span>`).join("")}` +
        (cap ? `<span><i class="lg-over"></i>超過上限的期間</span>` : "") +
        `<span><i class="lg-ms"></i>單日任務</span><span><i class="lg-done"></i>已完成</span></span>`;

      // ---- keep scroll unless the zoom or range start changed
      const prev = root.querySelector(".gantt-scroll");
      const keep = prev && cur && cur.zoom === zoomKey && cur.r0 === r0;
      const scroll = keep ? { l: prev.scrollLeft, t: prev.scrollTop } : null;

      root.innerHTML = "";
      const scroller = document.createElement("div");
      scroller.className = "gantt-scroll ld-scroll";
      const inner = document.createElement("div");
      inner.className = "gantt-inner";
      inner.style.width = `calc(var(--label-w) + ${W}px)`;
      scroller.appendChild(inner);

      // ---- header: date axis + load chart (sticky while the task rows scroll)
      let peakVis = 0;
      for (let d = Math.max(r0, m.lo); d <= Math.min(r1, m.hi); d++) peakVis = Math.max(peakVis, m.at(d));
      const top = Math.max(peakVis, cap || 0, 1);
      const step = top <= 8 ? 1 : top <= 20 ? 2 : 5;
      const yMax = Math.ceil(top / step) * step;
      const yOf = (c) => PLOT_BOT - (c / yMax) * (PLOT_BOT - PLOT_TOP);

      const head = document.createElement("div");
      head.className = "g-head";
      const corner = document.createElement("div");
      corner.className = "g-corner ld-corner";
      corner.style.height = AXIS_H + CHART_H + "px";
      let ticks = "";
      for (let v = 0; v <= yMax; v += step) ticks += `<span class="ld-ytick" style="top:${AXIS_H + yOf(v) - 7}px">${v}</span>`;
      corner.innerHTML =
        `<div class="ld-title">每日同時進行的 PFAM 數<small>${U.esc(what)}・同一 PFAM 多個 task 重疊只算 1</small></div>${ticks}` +
        (cap ? `<span class="ld-caplab" style="top:${AXIS_H + yOf(cap) - 8}px">上限 ${cap}</span>` : "");
      head.appendChild(corner);
      const hs = el("svg", { width: W, height: AXIS_H + CHART_H, class: "g-axis ld-head" });
      head.appendChild(hs);
      inner.appendChild(head);
      Gantt.drawAxis(hs, r0, r1, x, ppd, zoomKey, null, today);

      const g = el("g", { transform: `translate(0 ${AXIS_H})` }, hs);
      el("rect", { x: 0, y: 0, width: W, height: CHART_H, class: "ld-plot" }, g);
      for (let mo = monthStart(r0); mo <= r1; mo = addMonths(mo, 1)) {
        if (mo >= r0) el("line", { x1: x(mo) + 0.5, x2: x(mo) + 0.5, y1: 0, y2: CHART_H, class: "gridline" }, g);
      }
      for (let v = step; v <= yMax; v += step) el("line", { x1: 0, x2: W, y1: yOf(v) + 0.5, y2: yOf(v) + 0.5, class: "ld-ygrid" }, g);
      if (pin != null) el("rect", { x: x(pin), y: 0, width: Math.max(ppd, 2), height: CHART_H, class: "ld-pinband" }, g);
      // one step per run of days with the same count; the part above the limit in red
      for (let d = r0; d <= r1; ) {
        const c = m.at(d);
        let e = d;
        while (e < r1 && m.at(e + 1) === c) e++;
        if (c > 0) {
          const x0 = x(d);
          const w = (e - d + 1) * ppd;
          const base = cap ? Math.min(c, cap) : c;
          el("rect", { x: x0, y: yOf(base), width: w, height: PLOT_BOT - yOf(base), class: "ld-col" }, g);
          if (cap && c > cap) el("rect", { x: x0, y: yOf(c), width: w, height: yOf(cap) - yOf(c), class: "ld-col over" }, g);
          if (w >= 14) {
            const tx = el("text", { x: x0 + w / 2, y: yOf(c) - 3, class: "ld-num" + (cap && c > cap ? " over" : "") }, g);
            tx.textContent = c;
          }
        }
        d = e + 1;
      }
      el("line", { x1: 0, x2: W, y1: PLOT_BOT + 0.5, y2: PLOT_BOT + 0.5, class: "axisline" }, g);
      if (cap) el("line", { x1: 0, x2: W, y1: yOf(cap), y2: yOf(cap), class: "ld-capline" }, g);
      if (today >= r0 && today <= r1) el("line", { x1: x(today) + ppd / 2, x2: x(today) + ppd / 2, y1: 0, y2: CHART_H, class: "today" }, g);
      const guides = [el("line", { y1: 0, y2: CHART_H, class: "ld-guide", visibility: "hidden" }, g)];
      el("rect", { x: 0, y: 0, width: W, height: CHART_H, class: "ld-hit" }, g);

      // ---- body: one header row per PFAM, then its tasks
      const H = rows.length * ROW_H;
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
      const barG = el("g", {}, chart);

      for (let mo = monthStart(r0); mo <= r1; mo = addMonths(mo, 1)) {
        if (new Date(mo * 86400000).getUTCMonth() % 2 === 1) {
          const a = Math.max(mo, r0);
          el("rect", { x: x(a), y: 0, width: (addMonths(mo, 1) - a) * ppd, height: H, class: "mband" }, bg);
        }
        if (mo >= r0) el("line", { x1: x(mo) + 0.5, x2: x(mo) + 0.5, y1: 0, y2: H, class: "gridline" }, gridG);
      }
      if (zoomKey === "day") {
        for (let d = r0; d <= r1; d++) if (E.weekday(d) % 6 === 0) el("rect", { x: x(d), y: 0, width: ppd, height: H, class: "nonwork" }, bg);
      }

      const byKey = new Map();
      rows.forEach((r, i) => {
        const y = i * ROW_H;
        const cy = y + ROW_H / 2;
        const lab = document.createElement("div");
        if (r.unit) {
          const u = r.unit;
          const builds = u.members.length > 1 ? `<span class="tag builds">${u.members.map((mem) => U.esc(mem.build)).join(" + ")}</span>` : "";
          lab.className = "g-row is-section ld-sheet";
          lab.innerHTML =
            `<button class="caret" data-ldtoggle="${u.id}" aria-label="${r.collapsed ? "展開" : "收合"} PFAM" aria-expanded="${!r.collapsed}">${r.collapsed ? "▸" : "▾"}</button>` +
            `<span class="c-name" title="${U.esc(u.name)}\nExcel 分頁：${U.esc(u.members.map((mem) => mem.p.sheet).join("、"))}">${U.esc(u.name)}</span>` +
            builds +
            u.sites.map((st) => `<span class="tag site-${st}">${U.esc(st)}</span>`).join("") +
            `<span class="ld-n">${u.tasks.length} 個</span>`;
          labels.appendChild(lab);
          el("rect", { x: 0, y, width: W, height: ROW_H, class: "rowhit sec" }, bg);
          for (const [a, b] of cover(u.tasks)) {
            el("rect", { x: x(a), y: cy - 3, width: Math.max((b - a + 1) * ppd, 2), height: 6, rx: 1, class: "ld-cover" }, barG);
          }
          return;
        }
        const t = r.task;
        byKey.set(t.key, t);
        const hl = pin != null && active(t, pin);
        lab.className = "g-row ld-task" + (r.zebra ? " zebra" : "") + (hl ? " focus" : "");
        lab.dataset.id = t.key;
        lab.innerHTML =
          `<span class="c-name" title="${U.esc(t.t.name)}">${t.build ? `<span class="build-pill">${U.esc(t.build)}</span>` : ""}${U.esc(t.t.name)}</span>` +
          `<span class="role-pill${t.hit.length ? "" : " by-name"}">${t.hit.length ? U.esc(t.hit.join("/")) : "名稱"}</span>` +
          `<span class="c-lead" title="${U.esc(t.t.lead)}">${U.esc(t.t.lead)}</span>`;
        labels.appendChild(lab);
        el("rect", { x: 0, y, width: W, height: ROW_H, class: "rowhit" + (r.zebra ? " zebra" : "") + (hl ? " focus" : ""), "data-id": t.key }, bg);

        const cls = `s${slotOf(t.combo)}${Number(t.t.pct) >= 100 ? " done" : ""}${hl ? " focus" : ""}`;
        if (t.single) {
          const cx = x(t.a) + ppd / 2;
          const rr = 5.5;
          el("path", { d: `M${cx} ${cy - rr}L${cx + rr} ${cy}L${cx} ${cy + rr}L${cx - rr} ${cy}Z`, class: `ms ${cls}`, "data-id": t.key }, barG);
        } else {
          el("rect", { x: x(t.a), y: cy - BAR_H / 2, width: Math.max((t.b - t.a + 1) * ppd, 3), height: BAR_H, rx: 3, class: `bar ${cls}`, "data-id": t.key }, barG);
        }
        // the stretch of this task that falls in an over-limit period
        for (const [a, b] of over) {
          const s0 = Math.max(a, t.a);
          const s1 = Math.min(b, t.b);
          if (s0 <= s1) el("rect", { x: x(s0), y: cy - BAR_H / 2 - 5, width: Math.max((s1 - s0 + 1) * ppd, 2), height: 3, rx: 1, class: "ld-over" }, barG);
        }
      });
      if (!rows.length) {
        const tx = el("text", { x: 12, y: ROW_H / 2 + 4, class: "tick" }, barG);
        tx.textContent = "這天沒有進行中的 task";
      }

      if (pin != null) el("rect", { x: x(pin), y: 0, width: Math.max(ppd, 2), height: H, class: "ld-pinband" }, bg);
      if (today >= r0 && today <= r1) el("line", { x1: x(today) + ppd / 2, x2: x(today) + ppd / 2, y1: 0, y2: H, class: "today" }, gridG);
      guides.push(el("line", { y1: 0, y2: H, class: "ld-guide", visibility: "hidden" }, gridG));

      root.appendChild(scroller);
      cur = { m, r0, r1, ppd, x, cap, zoom: zoomKey, byKey, guides, unitIds: shown.map((u) => u.id), slotOf };

      if (scroll) {
        scroller.scrollLeft = scroll.l;
        scroller.scrollTop = scroll.t;
      } else {
        const anchor = pin != null ? pin - 14 : today > r0 && today < r1 ? today - 14 : r0;
        scroller.scrollLeft = Math.max(0, x(anchor) - 40);
      }
      this.scrollToDay = (day) => {
        scroller.scrollLeft = Math.max(0, x(day) - scroller.clientWidth / 3);
      };
    },

    dayTip(day) {
      const c = cur.m.at(day);
      const list = cur.m.all.filter((t) => t.a <= day && day <= t.b);
      const byUnit = new Map();
      for (const t of list) {
        if (!byUnit.has(t.unit)) byUnit.set(t.unit, []);
        byUnit.get(t.unit).push(t);
      }
      const capRow = cur.cap
        ? `<div class="tip-row"><span>上限</span><b class="${c > cur.cap ? "late" : ""}">${cur.cap}${c > cur.cap ? `（超過 ${c - cur.cap}）` : ""}</b></div>`
        : "";
      const units = [...byUnit];
      const items = units
        .slice(0, TIP_TASKS)
        .map(
          ([u, ts]) =>
            `<div class="ld-tip-task"><b>${U.esc(u.name)}</b> <span class="muted">${ts.length > 1 ? ts.length + " 個 task：" : ""}${U.esc(ts.map((t) => t.t.name).join("、"))}</span></div>`
        )
        .join("");
      const more = units.length > TIP_TASKS ? `<div class="muted">…另外 ${units.length - TIP_TASKS} 個 PFAM</div>` : "";
      return (
        `<div class="tip-title">${U.fmt(day, "full")}</div>` +
        `<div class="tip-row"><span>同時進行</span><b class="${cur.cap && c > cur.cap ? "late" : ""}">${c} 個 PFAM（${list.length} 個 task）</b></div>${capRow}` +
        (list.length ? `<div class="ld-tip-list">${items}${more}</div>` : "") +
        `<div class="ld-tip-hint">點一下標出這天的 task</div>`
      );
    },

    taskTip(t) {
      let most = 0;
      for (let d = t.a; d <= t.b; d++) most = Math.max(most, cur.m.at(d));
      const hot = cur.cap && most > cur.cap;
      const notes = t.t.notes ? `<div class="tip-notes">${U.esc(t.t.notes.length > 220 ? t.t.notes.slice(0, 220) + "…" : t.t.notes)}</div>` : "";
      return (
        `<div class="tip-title">${U.esc(t.t.name)}</div>` +
        `<div class="tip-row"><span>PFAM</span><b>${U.esc(t.unit.name)}${t.build ? ` · ${U.esc(t.build)}` : ""}</b></div>` +
        `<div class="tip-row"><span>Excel 分頁</span><b>${U.esc(t.p.sheet)}</b></div>` +
        (t.hit.length ? "" : `<div class="tip-row"><span>列入原因</span><b>任務名稱符合「${U.esc(t.byName)}」</b></div>`) +
        `<div class="tip-row"><span>負責</span><b>${U.esc(t.t.lead)}</b></div>` +
        `<div class="tip-row"><span>日期</span><b>${U.fmt(t.a, "full")} → ${U.fmt(t.b, "full")}</b></div>` +
        `<div class="tip-row"><span>工期</span><b>${t.t.workdays != null ? t.t.workdays + " 工作天" : "—"} · ${t.b - t.a + 1} 日曆天</b></div>` +
        (t.t.pct ? `<div class="tip-row"><span>完成</span><b>${t.t.pct}%</b></div>` : "") +
        `<div class="tip-row"><span>期間最多同時</span><b class="${hot ? "late" : ""}">${most} 個 PFAM${hot ? `（超過上限 ${most - cur.cap}）` : ""}</b></div>` +
        notes +
        `<div class="ld-tip-hint">雙擊開啟這個 PFAM 的甘特圖</div>`
      );
    },
  };

  window.Load = Load;
})();
