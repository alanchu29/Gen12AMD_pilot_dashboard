/*
 * Excel -> dataset converter (browser port of tools/excel_to_seed.py; same output).
 * Takes a SheetJS workbook read with { cellFormula: true, cellNF: true, cellDates: false }.
 * Runs in the browser (window.Importer) and in Node (tools/verify_importer.js compares it to the Python seed).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Importer = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Holiday sheet layout: [site, name column, date column]
  const HOLIDAY_COLS = [["WYMX", "A", "B"], ["WYLZ", "E", "F"], ["WYHQ", "I", "J"], ["WCZ", "M", "N"], ["WYMY", "Q", "R"]];
  const DATE_COL_TO_SITE = Object.fromEntries(HOLIDAY_COLS.map(([s, , d]) => [d, s]));

  const RE_START = /^=WORKDAY\(\s*(?:_xlfn\.)?XLOOKUP\(\s*J(\d+)\s*,\s*A:A\s*,\s*F:F\s*,\s*"Check"\s*,\s*0\s*,\s*1\s*\)\s*,\s*(-?\d+)\s*,\s*(.+)\)$/;
  const RE_END = /^=WORKDAY\(\s*E(\d+)\s*,\s*I(\d+)\s*([+-]\s*\d+)?\s*,\s*(.+)\)$/;
  const RE_HOL = /^(?:\[\d+\])?Holiday!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/;
  const EXCEL_EPOCH = 25569; // serial of 1970-01-01

  function convert(XLSX, wb, fileName) {
    const isDateFmt = (z) => !!z && XLSX.SSF.is_date(z);

    /** Cell value like openpyxl data_only: dates -> {iso}, errors -> "#NUM!" text. */
    function val(ws, addr) {
      const c = ws[addr];
      if (!c || c.v == null) return null;
      if (c.t === "e") return c.w || "#ERR!";
      if (c.t === "d") return { iso: c.v.toISOString().slice(0, 10) };
      if (c.t === "n" && isDateFmt(c.z)) {
        const days = Math.floor(c.v) - EXCEL_EPOCH;
        return { iso: new Date(days * 86400000).toISOString().slice(0, 10) };
      }
      if (c.t === "s" && typeof c.v === "string") return c.v.replace(/\r\n/g, "\n");
      return c.v;
    }
    /** Formula text like openpyxl ("=..."), or the raw value when the cell has no formula. */
    function formula(ws, addr) {
      const c = ws[addr];
      if (c && c.f) return "=" + c.f;
      const v = val(ws, addr);
      return v;
    }
    const iso = (v) => (v && typeof v === "object" && v.iso ? v.iso : null);
    const isStr = (v) => typeof v === "string";
    function clean(v) {
      if (v == null) return "";
      const s = (typeof v === "object" && v.iso ? v.iso + " 00:00:00" : String(v)).trim();
      return s.startsWith("#") && s.endsWith("!") ? "" : s;
    }
    const maxRow = (ws) => (ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).e.r + 1 : 0);

    function parseCal(arg, pfamCol) {
      arg = arg.trim();
      if (arg === "0") return ["none", null];
      const m = arg.match(RE_HOL);
      if (!m) return ["site", null];
      return [m[1] === pfamCol ? "site" : DATE_COL_TO_SITE[m[1]] || "site", null];
    }

    function readHolidays(ws) {
      const cals = {};
      const last = maxRow(ws);
      for (const [site, ncol, dcol] of HOLIDAY_COLS) {
        const byDate = new Map();
        let lastName = "";
        for (let r = 2; r <= last; r++) {
          const name = clean(val(ws, ncol + r)) || lastName;
          lastName = name;
          const d = iso(val(ws, dcol + r));
          if (!d) continue;
          byDate.set(d, { date: d, name }); // later rows win, like the Python dict
        }
        cals[site] = { site, holidays: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
      }
      return cals;
    }

    function majorityCol(ws) {
      const counts = {};
      const last = maxRow(ws);
      for (let r = 8; r <= last; r++) {
        for (const col of "EF") {
          const f = formula(ws, col + r);
          if (!isStr(f)) continue;
          for (const m of f.matchAll(/Holiday!\$?([A-Z]+)\$?\d+/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
        }
      }
      let best = null;
      for (const k of Object.keys(counts)) if (best == null || counts[k] > counts[best]) best = k;
      return best;
    }

    function convertSheet(name, ws, hidden, idx) {
      const pfamCol = majorityCol(ws);
      const siteText = clean(val(ws, "G1"));
      const calendar = DATE_COL_TO_SITE[pfamCol] || (siteText.toUpperCase().includes("MX") ? "WYMX" : "WYLZ");
      const tasks = [];
      const wbsToId = {};
      const pending = [];
      const notesBlocks = [];
      let n = 0;
      const last = maxRow(ws);

      for (let r = 8; r <= last; r++) {
        const a = val(ws, "A" + r);
        const b = clean(val(ws, "B" + r));
        const c = clean(val(ws, "C" + r));
        const eV = val(ws, "E" + r);
        const fV = val(ws, "F" + r);
        const eF = formula(ws, "E" + r);
        const fF = formula(ws, "F" + r);
        const work = val(ws, "I" + r);
        const aS = clean(a);

        if (aS && !/^\d+(\.\d+)*$/.test(aS) && !b) {
          notesBlocks.push(aS);
          continue;
        }
        if (!b) continue;

        const isSection = (aS && !aS.includes(".")) || (!aS && work == null && !c);
        n++;
        const tid = "t" + n;
        if (isSection) {
          const task = { id: tid, type: "section", name: b };
          if (!aS) task.unnumbered = true;
          if (isStr(eV) && clean(eV)) task.notes = clean(eV);
          tasks.push(task);
          continue;
        }

        const task = {
          id: tid, type: "task", name: b, lead: c,
          startMode: "none", pred: null, lag: 1, start: null,
          workdays: typeof work === "number" ? work : null,
          endMode: "dur", endAdj: -1, end: null,
          startCal: "site", endCal: "site",
          pct: 0, code: clean(val(ws, "K" + r)), notes: clean(val(ws, "L" + r)),
        };
        const pct = val(ws, "H" + r);
        if (typeof pct === "number") task.pct = pct > 0 && pct <= 1 ? Math.round(pct * 100) : Math.trunc(pct);
        if (aS) wbsToId[aS] = tid;
        const xlStart = iso(eV);
        const xlEnd = iso(fV);

        const m = isStr(eF) ? eF.match(RE_START) : null;
        if (m && Number(m[1]) === r) {
          task.startMode = "dep";
          task.lag = Number(m[2]);
          task.startCal = parseCal(m[3], pfamCol)[0];
          pending.push([task, clean(val(ws, "J" + r))]);
        } else if (xlStart) {
          task.startMode = "manual";
          task.start = xlStart;
          if (isStr(eF) && eF.startsWith("=")) task.notes = (task.notes ? task.notes + "\n" : "") + `[Excel START formula ${eF}]`;
        } else if (isStr(eV) && clean(eV)) {
          task.startText = clean(eV);
        }

        const me = isStr(fF) ? fF.match(RE_END) : null;
        if (me && Number(me[1]) === r && Number(me[2]) === r) {
          task.endAdj = me[3] ? Number(me[3].replace(/\s+/g, "")) : 0;
          task.endCal = parseCal(me[4], pfamCol)[0];
        } else if (xlEnd) {
          task.endMode = "manual";
          task.end = xlEnd;
        }

        if (xlStart || xlEnd) task.base = { start: xlStart, end: xlEnd };
        tasks.push(task);
      }

      for (const [task, predWbs] of pending) {
        const pid = wbsToId[predWbs] || null;
        task.pred = pid;
        if (!pid) task.predMissing = predWbs;
      }

      return {
        id: "p" + String(idx).padStart(3, "0"),
        sheet: name.trim(),
        // Exact Excel name = identity for re-imports ("x (3.5)" and "x (3.5) " are different sheets).
        xlSheet: name,
        title: clean(val(ws, "A1")),
        site: siteText.replace(/^@+/, "") || calendar,
        calendar,
        hidden,
        order: idx,
        meta: {
          l11pn: clean(val(ws, "B2")),
          l10pn: clean(val(ws, "B3")),
          mdm: clean(val(ws, "C2")),
          lead: clean(val(ws, "C5")),
        },
        assumptions: notesBlocks.join("\n\n"),
        tasks,
      };
    }

    if (!wb.Sheets.Holiday) throw new Error("找不到 Holiday 工作表，這不是預期格式的排程 Excel");
    const calendars = readHolidays(wb.Sheets.Holiday);
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
    const pfams = [];
    wb.SheetNames.forEach((name, i) => {
      const ws = wb.Sheets[name];
      if (!ws || val(ws, "B7") !== "TASK") return;
      const hidden = !!(meta[i] && meta[i].Hidden);
      pfams.push(convertSheet(name, ws, hidden, pfams.length + 1));
    });
    if (!pfams.length) throw new Error("沒有找到任何排程分頁（第 7 列應為 # / TASK / LEAD …）");

    return {
      schema: 1,
      source: { file: fileName, importedAt: new Date().toISOString().slice(0, 19) },
      calendars,
      pfams,
    };
  }

  return { convert };
});
