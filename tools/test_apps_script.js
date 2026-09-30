// Round-trip test for apps-script/Code.gs using an in-memory SpreadsheetApp mock.
//   node tools/test_apps_script.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const Engine = require("../js/engine.js");

// ---- minimal Sheets mock (cells hold what getDisplayValues would show) ----
class Range {
  constructor(sh, r, c, nr, nc) {
    Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 });
  }
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error("setValues size mismatch");
    v.forEach((row, i) => row.forEach((val, j) => this.sh.set(this.r + i, this.c + j, val)));
    return this;
  }
  getDisplayValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sh.get(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getDisplayValue() {
    return this.sh.get(this.r, this.c);
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, "");
    return this;
  }
  setNumberFormat() {
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.maxRows = 1000;
    this.maxCols = 26;
  }
  set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && s.startsWith("'")) s = s.slice(1); // Sheets hides the text-forcing apostrophe
    else if (typeof v === "string" && /^[=+\-@]/.test(s)) throw new Error("Unescaped formula-like string written: " + s);
    this.rows[r - 1][c - 1] = s;
    if (r > this.maxRows) this.maxRows = r;
  }
  get(r, c) {
    const row = this.rows[r - 1];
    return row && row[c - 1] != null ? row[c - 1] : "";
  }
  getRange(r, c, nr, nc) {
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some((v) => v !== "" && v != null)) return i;
    return 0;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  setFrozenRows() {}
  insertRowsAfter(after, n) {
    this.rows.splice(after, 0, ...Array.from({ length: n }, () => []));
    this.maxRows += n;
  }
  deleteRows(start, n) {
    if (this.maxRows - n < 2) throw new Error("cannot delete all non-frozen rows");
    this.rows.splice(start - 1, n);
    this.maxRows -= n;
  }
}

// ---- CacheService / Utilities mocks (values over 100 KB are rejected, like the real CacheService) ----
const cacheStore = new Map();
const cache = {
  get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
  getAll: (keys) => Object.fromEntries(keys.filter((k) => cacheStore.has(k)).map((k) => [k, cacheStore.get(k)])),
  putAll(entries) {
    for (const [k, v] of Object.entries(entries)) {
      if (Buffer.byteLength(v) > 100 * 1024) throw new Error("cache value too large: " + k);
      cacheStore.set(k, v);
    }
  },
  remove: (k) => cacheStore.delete(k),
};
class Blob {
  constructor(buf) {
    this.buf = buf;
  }
  getBytes() {
    return [...this.buf].map((b) => (b > 127 ? b - 256 : b)); // Apps Script bytes are signed
  }
  getDataAsString() {
    return this.buf.toString("utf8");
  }
}
const toBuf = (d) => (typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d.map((b) => b & 255)));

const sheets = {};
const ctx = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet(n)) }),
  },
  ContentService: {
    MimeType: { JSON: "json", JAVASCRIPT: "js" },
    createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "EDIT_KEY" ? ctx.__key : null) }) },
  CacheService: { getScriptCache: () => cache },
  Utilities: {
    newBlob: (d) => new Blob(toBuf(d)),
    gzip: (b) => new Blob(zlib.gzipSync(b.buf)),
    ungzip: (b) => new Blob(zlib.gunzipSync(b.buf)),
    base64Encode: (bytes) => toBuf(bytes).toString("base64"),
    base64Decode: (s) => [...Buffer.from(s, "base64")].map((b) => (b > 127 ? b - 256 : b)),
  },
  __key: null,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8"), ctx);

const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (params) => ctx.doGet({ parameter: params }).text;
const bundle = () => JSON.parse(get({ action: "bundle" })).data;

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || extra === undefined ? "" : "  -> " + JSON.stringify(extra).slice(0, 400)));
  if (!cond) fails++;
};

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/seed.json"), "utf8"));

// Compare ignoring empty values and the defaults the server fills in.
function norm(p) {
  const tasks = p.tasks.map((t) => {
    const o = {};
    for (const [k, v] of Object.entries(t)) if (v !== "" && v !== null && v !== undefined && v !== false) o[k] = v;
    if (t.type === "task") {
      o.lag = t.lag || 0;
      o.endAdj = t.endAdj || 0;
      o.pct = t.pct || 0;
    }
    return Object.fromEntries(Object.entries(o).sort());
  });
  const meta = Object.fromEntries(Object.entries(p.meta || {}).map(([k, v]) => [k, v || ""]).sort());
  const out = { id: p.id, sheet: p.sheet, title: p.title, site: p.site, calendar: p.calendar, hidden: !!p.hidden, order: p.order, meta, assumptions: p.assumptions || "", tasks };
  return JSON.stringify(out);
}

// 1. import + bundle
const imp = post({ action: "importAll", data: seed });
check("importAll ok", imp.ok && imp.pfams === seed.pfams.length, imp);

const cbText = get({ action: "bundle", callback: "cb_1" });
check("JSONP wrapper", cbText.startsWith("cb_1(") && cbText.endsWith(")"));
check("JSONP rejects unsafe callback", !get({ action: "bundle", callback: "alert(1)//" }).startsWith("alert"));

let data = bundle();
check("bundle cached in chunks", Number(cacheStore.get("bundle:n")) > 1, cacheStore.get("bundle:n"));
{
  // A cached read must not touch the sheets: hide them and read again.
  const saved = { ...sheets };
  for (const k of Object.keys(sheets)) delete sheets[k];
  const cached = bundle();
  Object.assign(sheets, saved);
  check("bundle served from cache", JSON.stringify(cached) === JSON.stringify(data));
}
check("onEdit clears cache", (ctx.onEdit(), !cacheStore.has("bundle:n")));
check("rebuilt after onEdit", JSON.stringify(bundle()) === JSON.stringify(data));
check("pfam count", data.pfams.length === seed.pfams.length, data.pfams.length);
check("calendars", Object.keys(data.calendars).length === 5 && data.calendars.WYLZ.holidays.length === seed.calendars.WYLZ.holidays.length);
check("source meta", data.source.file === seed.source.file);

let mism = 0;
let first = null;
for (const sp of seed.pfams) {
  const dp = data.pfams.find((p) => p.id === sp.id);
  const a = norm(sp);
  const b = norm(dp);
  if (a !== b) {
    mism++;
    if (!first) {
      let i = 0;
      while (a[i] === b[i]) i++;
      first = { id: sp.id, seed: a.slice(i - 80, i + 120), cloud: b.slice(i - 80, i + 120) };
    }
  }
}
check("round-trip equal for all PFAMs", mism === 0, first);

let diffs = 0;
for (const sp of seed.pfams) {
  const dp = data.pfams.find((p) => p.id === sp.id);
  const a = Engine.schedule(sp, seed.calendars);
  const b = Engine.schedule(dp, data.calendars);
  for (const [id, r] of a.rows) {
    const r2 = b.rows.get(id);
    if (r.start !== r2.start || r.end !== r2.end) diffs++;
  }
}
check("schedule identical after round-trip", diffs === 0, diffs);

// 2. savePfam: grow, conflict, shrink, force
const p = JSON.parse(JSON.stringify(data.pfams[3]));
const v0 = p.version;
p.tasks.push({ id: "tNew", type: "task", name: "=danger +formula", lead: "-x", startMode: "manual", start: "2027-01-04", workdays: 3, endMode: "dur", endAdj: -1, lag: 0, pct: 0 });
const meta = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "tasks"));
const s1 = post({ action: "savePfam", pfam: meta(p), tasks: p.tasks, baseVersion: v0 });
check("savePfam grow", s1.ok && s1.version === v0 + 1, s1);
let b2 = bundle();
let p2 = b2.pfams.find((x) => x.id === p.id);
check("formula-like text survives", p2.tasks.length === p.tasks.length && p2.tasks[p2.tasks.length - 1].name === "=danger +formula" && p2.tasks[p2.tasks.length - 1].lead === "-x");
check("neighbour PFAM untouched", b2.pfams[4].tasks.length === data.pfams[4].tasks.length && b2.pfams[2].tasks.length === data.pfams[2].tasks.length);

const s2 = post({ action: "savePfam", pfam: meta(p), tasks: p.tasks.slice(0, 5), baseVersion: v0 });
check("stale baseVersion -> conflict", s2.conflict === true && !s2.ok, s2);

const s3 = post({ action: "savePfam", pfam: meta(p), tasks: p.tasks.slice(0, 5), baseVersion: s1.version });
b2 = bundle();
p2 = b2.pfams.find((x) => x.id === p.id);
check("savePfam shrink", s3.ok && p2.tasks.length === 5, [s3, p2.tasks.length]);
check("neighbours intact after shrink", norm(b2.pfams[2]) === norm(data.pfams[2]) && norm(b2.pfams[4]) === norm(data.pfams[4]));

const s4 = post({ action: "savePfam", pfam: meta(p), tasks: p.tasks, baseVersion: null });
check("force save", s4.ok && s4.version === s3.version + 1, s4);

// 2b. Excel reference (_xl) and import fields survive the cloud
const withRef = JSON.parse(JSON.stringify(b2.pfams.find((x) => x.id === p.id)));
withRef._xl = { id: p.id, sheet: "orig", tasks: [{ id: "t1", type: "task", name: "=x", start: "2027-01-04" }] };
withRef.baselineLabel = "上一版 Excel（a.xlsx）";
withRef.xlSheet = "12.1_orig (3)";
const s6 = post({ action: "savePfam", pfam: meta(withRef), tasks: withRef.tasks, baseVersion: null });
const back = bundle().pfams.find((x) => x.id === p.id);
check("_xl / baselineLabel / xlSheet round-trip", s6.ok && JSON.stringify(back._xl) === JSON.stringify(withRef._xl) && back.baselineLabel === withRef.baselineLabel && back.xlSheet === withRef.xlSheet && !("xlRef" in back), back._xl);

// 3. create + delete PFAM
const np = { id: "pNew", sheet: "new", title: "", site: "WYLZ", calendar: "WYLZ", hidden: false, order: 99, meta: {} };
const s5 = post({ action: "savePfam", pfam: np, tasks: [{ id: "a", type: "section", name: "S" }], baseVersion: 0 });
check("create new pfam", s5.ok && s5.version === 1, s5);
check("delete pfam", post({ action: "deletePfam", id: "pNew" }).ok);
b2 = bundle();
check("deleted pfam gone", !b2.pfams.some((x) => x.id === "pNew") && b2.pfams.length === seed.pfams.length);

// 4. calendars
const cals = JSON.parse(JSON.stringify(seed.calendars));
cals.WYLZ.holidays.push({ date: "2030-01-01", name: "x" });
bundle();
check("saveCalendars", post({ action: "saveCalendars", calendars: cals }).ok);
check("write clears cache", !cacheStore.has("bundle:n"));
check("calendar saved", bundle().calendars.WYLZ.holidays.some((h) => h.date === "2030-01-01"));

// 5. edit key
ctx.__key = "secret";
check("wrong key rejected", post({ action: "deletePfam", id: "x" }).ok === false);
check("right key accepted", post({ action: "deletePfam", id: "x", key: "secret" }).ok === true);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
