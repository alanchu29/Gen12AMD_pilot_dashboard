// Check that the browser importer (js/importer.js) produces exactly the Python seed.
//   python tools/excel_to_seed.py "<xlsx>"      (writes data/seed.json)
//   node tools/verify_importer.js "<xlsx>"
const fs = require("fs");
const path = require("path");
const XLSX = require("../js/vendor/xlsx.full.min.js");
const Importer = require("../js/importer.js");

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/verify_importer.js "<xlsx>"');
  process.exit(2);
}
const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", cellFormula: true, cellNF: true, cellDates: false });
const js = Importer.convert(XLSX, wb, path.basename(file));
const py = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/seed.json"), "utf8"));

const diffs = [];
function cmp(a, b, where) {
  if (diffs.length > 40) return;
  if (a === b) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) cmp(a[k], b[k], `${where}.${k}`);
    return;
  }
  diffs.push(`${where}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`);
}

cmp(js.calendars, py.calendars, "calendars");
if (js.pfams.length !== py.pfams.length) diffs.push(`pfam count js=${js.pfams.length} py=${py.pfams.length}`);
js.pfams.forEach((p, i) => cmp(p, py.pfams[i], `pfams[${i}](${p.sheet})`));
cmp(js.source.file, py.source.file, "source.file");

const tasks = js.pfams.reduce((a, p) => a + p.tasks.length, 0);
if (diffs.length) {
  console.log(`MISMATCH (${diffs.length}${diffs.length > 40 ? "+" : ""}):`);
  for (const d of diffs) console.log("  " + d);
  process.exit(1);
}
console.log(`identical: ${js.pfams.length} PFAMs, ${tasks} rows, ${Object.keys(js.calendars).length} calendars`);
