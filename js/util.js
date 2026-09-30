/* Shared helpers: formatting, PFAM tags, owner grouping, DOM shortcuts. */
(function () {
  const E = window.Engine;

  const OWNER_GROUPS = [
    { key: "ww", label: "Wiwynn", slot: 1 },
    { key: "msft", label: "MSFT", slot: 2 },
    { key: "joint", label: "MSFT + Wiwynn", slot: 3 },
    { key: "vendor", label: "供應商 (AMD 等)", slot: 4 },
    { key: "none", label: "未指定", slot: 0 },
  ];
  const VENDOR = /^(AMD|AMI|INTEL|LANAI|AMPHENOL)$/i;

  function ownerGroup(lead) {
    const parts = String(lead || "")
      .split(/[,\/、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return "none";
    const msft = parts.some((p) => /MSFT/i.test(p));
    const vendor = parts.every((p) => VENDOR.test(p));
    const other = parts.some((p) => !/MSFT/i.test(p));
    if (vendor) return "vendor";
    if (msft && other) return "joint";
    if (msft) return "msft";
    return "ww";
  }

  /** Classify a PFAM by its sheet name (falls back to title / site). */
  function tags(p) {
    const s = p.sheet;
    const gen = (s.match(/^(1\d\.\d)/) || p.title.match(/GEN\s*(1\d\.\d)/i) || [])[1] || "其他";
    let site = (s.match(/(?:^|_)(LZ|MX)(?=[_( ]|$)/) || [])[1];
    if (!site) site = /MX/i.test(p.site) ? "MX" : /LZ/i.test(p.site) ? "LZ" : "";
    const phase = /pre\s*ga/i.test(s) ? "Pre GA" : /1st/i.test(s) ? "1st" : /2nd/i.test(s) ? "2nd" : "其他";
    const skuTok = (s.match(/_(D?[HML][HML])(?=[_( ]|$)/) || [])[1];
    const sku = skuTok ? (skuTok.startsWith("D") ? "GPD-" + skuTok.slice(1) : "GP-" + skuTok) : /lanai/i.test(s) ? "Lanai" : /DV/.test(s) ? "DV" : "";
    return { gen, site, phase, sku };
  }

  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  function fmt(day, style) {
    if (day == null) return "";
    const iso = E.fromDay(day);
    const [y, m, d] = iso.split("-");
    if (style === "short") return `${+m}/${+d}`;
    if (style === "md") return `${m}/${d}`;
    if (style === "yy") return `${y.slice(2)}/${m}/${d}`;
    if (style === "full") return `${y}/${m}/${d} (${WD[E.weekday(day)]})`;
    return `${y}/${m}/${d}`;
  }

  function signedDays(n) {
    if (!n) return "0d";
    return (n > 0 ? "+" : "−") + Math.abs(n) + "d";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Key dates for list/KPI display: first ETD and final dock. */
  function keyDates(pfam, sched) {
    const m = sched.milestones;
    const pick = (codes, last) => {
      for (const c of codes) {
        const arr = (m[c] || []).filter((x) => x.start != null);
        if (arr.length) return last ? arr[arr.length - 1] : arr[0];
      }
      return null;
    };
    const byName = (re) => {
      const hits = pfam.tasks.filter((t) => t.type === "task" && re.test(t.name));
      const t = hits[hits.length - 1];
      const r = t && sched.rows.get(t.id);
      return r && r.start != null ? { start: r.start, end: r.end, taskId: t.id } : null;
    };
    const etd = pick(["PlannedShipDate"], false) || byName(/^ETD\b/i);
    const dock = pick(["PlannedETADockDate"], true) || byName(/dock date/i);
    const build = pick(["BuildStartDate", "GoldenRackStartDate"], false);
    let dockBase = null;
    if (dock) {
      const t = pfam.tasks.find((x) => x.id === dock.taskId);
      dockBase = t && t.base && t.base.start ? E.toDay(t.base.start) : null;
    }
    return { etd, dock, build, dockDelta: dock && dockBase != null ? dock.start - dockBase : null };
  }

  /** Roles in a LEAD cell that match the highlight list ("STE, TE" + ["STE","MTE"] -> ["STE"]). */
  function matchRoles(lead, roles) {
    if (!lead || !roles || !roles.length) return [];
    const toks = String(lead).toUpperCase().split(/[,\/、;&+\s]+/).filter(Boolean);
    return roles.filter((r) => toks.includes(String(r).trim().toUpperCase()));
  }

  function parseRoles(text) {
    return String(text || "")
      .split(/[,\/、;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  /** Where a PFAM stands today, from its key dates. */
  const PHASES = {
    future: { label: "未開始", icon: "○" },
    prep: { label: "準備中", icon: "●" },
    build: { label: "建置測試中", icon: "●" },
    ship: { label: "出貨運輸中", icon: "●" },
    done: { label: "已到貨", icon: "✓" },
    none: { label: "無日期", icon: "–" },
  };
  function phaseOf(key, span, today) {
    const at = (x) => (x ? x.start : null);
    let k = "none";
    if (span.start == null) k = "none";
    else if (at(key.dock) != null && today >= at(key.dock)) k = "done";
    else if (at(key.etd) != null && today >= at(key.etd)) k = "ship";
    else if (at(key.build) != null && today >= at(key.build)) k = "build";
    else if (today >= span.start) k = "prep";
    else k = "future";
    return { key: k, ...PHASES[k] };
  }

  function today() {
    return E.toDay(new Date().toISOString().slice(0, 10));
  }

  window.U = { OWNER_GROUPS, ownerGroup, tags, fmt, signedDays, esc, $, debounce, uid, keyDates, matchRoles, parseRoles, phaseOf, today };
})();
