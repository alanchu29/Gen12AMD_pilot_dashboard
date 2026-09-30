// Verify js/engine.js against the dates Excel cached in the workbook.
//   node tools/verify_engine.js            summary
//   node tools/verify_engine.js --detail   list every mismatch
// Mode "exact": uses each formula's exact Holiday!range -> proves the engine matches Excel's math.
// Mode "app":   uses the full site calendar (what the web app does) -> shows where the workbook
//               itself is inconsistent (truncated holiday ranges, stale values, broken refs).
const fs = require("fs");
const path = require("path");
const Engine = require("../js/engine.js");

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/seed.json"), "utf8"));
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "_fixture.json"), "utf8"));
const detail = process.argv.includes("--detail");

function exactCalendars(pfam, pfx) {
  const cals = { ...seed.calendars };
  const tasks = pfam.tasks.map((t) => {
    const f = pfx.tasks[t.id];
    if (!f) return t;
    const copy = { ...t };
    for (const [key, rngKey] of [["startCal", "startRange"], ["endCal", "endRange"]]) {
      const rng = f[rngKey];
      if (!rng) continue;
      const id = `X:${rng.col}:${rng.r1}:${rng.r2}`;
      if (!cals[id]) {
        const rows = fx.holidayCols[rng.col] || {};
        const holidays = Object.entries(rows)
          .filter(([r]) => +r >= rng.r1 && +r <= rng.r2)
          .map(([, date]) => ({ date }));
        cals[id] = { holidays };
      }
      copy[key] = id;
    }
    return copy;
  });
  return { pfam: { ...pfam, tasks }, cals };
}

function compare(mode) {
  let total = 0, ok = 0;
  const bad = [];
  for (const pfam of seed.pfams) {
    const pfx = fx.pfams[pfam.id];
    const { pfam: p, cals } = mode === "exact" ? exactCalendars(pfam, pfx) : { pfam, cals: seed.calendars };
    const res = Engine.schedule(p, cals);
    const wbs = Engine.wbsMap(p);
    for (const t of pfam.tasks) {
      if (t.type !== "task") continue;
      const f = pfx.tasks[t.id];
      if (mode === "exact" && f.sheetWbs && wbs.get(t.id) !== f.sheetWbs)
        bad.push({ sheet: pfam.sheet, row: f.row, kind: "WBS", excel: f.sheetWbs, engine: wbs.get(t.id) });
      if (!f.xlStart && !f.xlEnd) continue;
      total++;
      const r = res.rows.get(t.id);
      const s = Engine.fromDay(r.start), e = Engine.fromDay(r.end);
      if (s === f.xlStart && e === f.xlEnd) ok++;
      else bad.push({ sheet: pfam.sheet, hidden: pfam.hidden, row: f.row, name: t.name, excel: `${f.xlStart} ~ ${f.xlEnd}`, engine: `${s} ~ ${e}`, err: r.error || "" });
    }
  }
  console.log(`[${mode}] dated tasks: ${total}, identical: ${ok}, different: ${total - ok}`);
  const bySheet = {};
  for (const b of bad) bySheet[b.sheet] = (bySheet[b.sheet] || 0) + 1;
  if (detail) for (const b of bad) console.log("  ", JSON.stringify(b));
  else for (const [s, n] of Object.entries(bySheet)) console.log(`   ${n.toString().padStart(3)}  ${s}`);
  return bad;
}

compare("exact");
compare("app");
