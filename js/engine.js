/*
 * Scheduling engine: reproduces the workbook's WORKDAY/XLOOKUP chain.
 *   start (dep)    = WORKDAY(pred.end, lag, holidays)
 *   end   (dur)    = WORKDAY(start, workdays + endAdj, holidays)
 * Dates are ISO strings at the edges and integer day numbers (UTC) inside.
 * Runs in the browser (window.Engine) and in Node (module.exports) for verification.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== "undefined" ? self : this, function () {
  const DAY_MS = 86400000;

  function toDay(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  }

  function fromDay(n) {
    if (n == null) return null;
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }

  // 1970-01-01 was a Thursday -> day 0 has weekday 4 (0 = Sunday)
  function weekday(n) {
    return (((n + 4) % 7) + 7) % 7;
  }

  function isWorkday(n, hol) {
    const w = weekday(n);
    return w !== 0 && w !== 6 && !(hol && hol.has(n));
  }

  /** Excel WORKDAY(start, days, holidays). days = 0 returns start unchanged. */
  function workday(start, days, hol) {
    if (start == null || days == null || !isFinite(days)) return null;
    days = Math.trunc(days);
    let n = start;
    const step = days > 0 ? 1 : -1;
    let left = Math.abs(days);
    while (left > 0) {
      n += step;
      if (isWorkday(n, hol)) left--;
    }
    return n;
  }

  /** Excel NETWORKDAYS(a, b, holidays), inclusive; negative when b < a. */
  function networkdays(a, b, hol) {
    if (a == null || b == null) return null;
    const sign = b >= a ? 1 : -1;
    let count = 0;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (isWorkday(n, hol)) count++;
    return sign * count;
  }

  const holidayCache = new WeakMap();
  function holidaySet(cal) {
    if (!cal) return null;
    let set = holidayCache.get(cal);
    if (!set) {
      set = new Set(cal.holidays.map((h) => toDay(h.date)));
      holidayCache.set(cal, set);
    }
    return set;
  }

  /** Resolve a task's calendar rule ("site" | "none" | site code) to a holiday Set. */
  function calFor(rule, pfam, calendars) {
    if (rule === "none") return null;
    const key = rule === "site" || !rule ? pfam.calendar : rule;
    return holidaySet(calendars[key]) || holidaySet(calendars[pfam.calendar]);
  }

  /**
   * Compute every task's dates.
   * Returns { rows: Map(id -> {start, end, days, error, section}), span: {start, end}, milestones }
   */
  function schedule(pfam, calendars) {
    const byId = new Map(pfam.tasks.map((t) => [t.id, t]));
    const out = new Map();
    const visiting = new Set();

    function solve(id) {
      if (out.has(id)) return out.get(id);
      const t = byId.get(id);
      if (!t) return { start: null, end: null, error: "找不到前置任務" };
      if (visiting.has(id)) return { start: null, end: null, error: "循環相依" };
      visiting.add(id);

      let start = null;
      let error = null;
      if (t.startMode === "manual") {
        start = toDay(t.start);
      } else if (t.startMode === "dep") {
        if (!t.pred) {
          error = t.predMissing ? `前置 ${t.predMissing} 不存在` : "未指定前置任務";
        } else {
          const p = solve(t.pred);
          if (p.end == null) error = p.error === "循環相依" ? "循環相依" : "前置任務無日期";
          else start = workday(p.end, Number(t.lag) || 0, calFor(t.startCal, pfam, calendars));
        }
      }

      let end = null;
      if (t.endMode === "manual") end = toDay(t.end);
      else if (start != null && t.workdays != null && t.workdays !== "")
        end = workday(start, Number(t.workdays) + (Number(t.endAdj) || 0), calFor(t.endCal, pfam, calendars));

      if (start != null && end != null && end < start && !error) error = "結束早於開始";
      const res = { start, end, days: start != null && end != null ? Math.max(end - start + 1, 1) : null, error };
      visiting.delete(id);
      out.set(id, res);
      return res;
    }

    for (const t of pfam.tasks) if (t.type === "task") solve(t.id);

    // Sections span their children (tasks until the next section).
    let sec = null;
    let min = Infinity;
    let max = -Infinity;
    const closeSection = () => {
      if (sec) out.set(sec.id, { section: true, start: isFinite(sec.min) ? sec.min : null, end: isFinite(sec.max) ? sec.max : null });
    };
    for (const t of pfam.tasks) {
      if (t.type === "section") {
        closeSection();
        sec = { id: t.id, min: Infinity, max: -Infinity };
        continue;
      }
      const r = out.get(t.id);
      for (const v of [r.start, r.end]) {
        if (v == null) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
        if (sec) {
          sec.min = Math.min(sec.min, v);
          sec.max = Math.max(sec.max, v);
        }
      }
    }
    closeSection();

    // A code can repeat (e.g. one ETD per shipment batch): keep them all in sheet order.
    const milestones = {};
    for (const t of pfam.tasks) {
      if (t.type !== "task" || !t.code) continue;
      const r = out.get(t.id);
      (milestones[t.code] = milestones[t.code] || []).push({ start: r.start, end: r.end, taskId: t.id });
    }

    return { rows: out, span: { start: isFinite(min) ? min : null, end: isFinite(max) ? max : null }, milestones };
  }

  /** Auto WBS numbering like the workbook's prevWBS formula: sections "n", tasks "n.k". */
  function wbsMap(pfam) {
    const map = new Map();
    let s = 0;
    let k = 0;
    let numbered = false;
    for (const t of pfam.tasks) {
      if (t.type === "section") {
        numbered = !t.unnumbered;
        if (numbered) {
          s++;
          k = 0;
          map.set(t.id, String(s));
        } else map.set(t.id, "");
      } else if (numbered && s > 0) {
        k++;
        map.set(t.id, `${s}.${k}`);
      } else map.set(t.id, "");
    }
    return map;
  }

  return { toDay, fromDay, weekday, isWorkday, workday, networkdays, holidaySet, calFor, schedule, wbsMap };
});
