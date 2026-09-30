/**
 * Gen12AMD_Pilot_gantt - Google Apps Script backend.
 *
 * Bind this script to an empty Google Sheet (Extensions > Apps Script), paste this file,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Sheets (PFAMs / Tasks / Holidays / Meta) are created automatically on first use.
 *
 * Optional write protection: Project Settings > Script properties > EDIT_KEY = <secret>.
 * The web app must then be given the same key in its cloud settings.
 *
 * GET  ?action=ping|bundle[&callback=fn]      (JSONP when callback is given)
 * POST {action:"importAll", data}             replace everything
 *      {action:"savePfam", pfam, tasks, baseVersion}   optimistic lock on version
 *      {action:"deletePfam", id}
 *      {action:"saveCalendars", calendars}
 */

var PFAM_COLS = ['id', 'sheet', 'title', 'site', 'calendar', 'hidden', 'order', 'version', 'updatedAt', 'baselineAt',
  'l11pn', 'l10pn', 'mdm', 'lead', 'assumptions', 'group', 'xlSheet', 'baselineLabel', 'xlRef'];
var TASK_COLS = ['pfamId', 'id', 'type', 'name', 'lead', 'startMode', 'pred', 'lag', 'start', 'workdays', 'endMode',
  'endAdj', 'end', 'startCal', 'endCal', 'pct', 'code', 'notes', 'startText', 'baseStart', 'baseEnd', 'unnumbered',
  'predMissing'];
var HOLIDAY_COLS = ['site', 'date', 'name'];
var META_COLS = ['key', 'value'];

var NUMERIC = { lag: 1, workdays: 1, endAdj: 1, pct: 1, order: 1, version: 1 };
var BOOLEAN = { hidden: 1, unnumbered: 1 };
var META_FIELDS = { l11pn: 1, l10pn: 1, mdm: 1, lead: 1 };

// ---------------------------------------------------------------- HTTP entry points

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'bundle') out = { ok: true, data: readBundle_() };
    else out = { ok: true, service: 'Gen12AMD_Pilot_gantt', time: new Date().toISOString() };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return respond_(out, p.callback);
}

function doPost(e) {
  var out;
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    lock.waitLock(30000);
    switch (body.action) {
      case 'importAll': out = importAll_(body.data); break;
      case 'savePfam': out = savePfam_(body.pfam, body.tasks || [], body.baseVersion); break;
      case 'deletePfam': out = deletePfam_(body.id); break;
      case 'saveCalendars': writeHolidays_(body.calendars || {}); out = { ok: true }; break;
      default: out = { ok: false, error: 'Unknown action: ' + body.action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  return respond_(out);
}

function respond_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('EDIT_KEY');
  if (expected && key !== expected) throw new Error('Edit key 不正確，無法寫入');
}

// ---------------------------------------------------------------- sheet helpers

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  }
  return sh;
}

function readRows_(name, cols) {
  var sh = sheet_(name, cols);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  return sh.getRange(2, 1, last - 1, header.length).getDisplayValues().map(function (r) {
    var o = {};
    header.forEach(function (h, i) { if (h) o[h] = r[i]; });
    return o;
  });
}

/** Protect strings Sheets would parse as formulas; numbers/booleans pass through. */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : '';
  if (typeof v === 'number') return v;
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function toRow_(obj, cols) {
  return cols.map(function (c) { return cell_(obj[c]); });
}

function writeBlock_(sh, startRow, rows, width) {
  if (!rows.length) return;
  var rg = sh.getRange(startRow, 1, rows.length, width);
  rg.setNumberFormat('@');
  rg.setValues(rows);
}

function rewrite_(name, cols, rows) {
  var sh = sheet_(name, cols);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getMaxColumns()).clearContent();
  writeBlock_(sh, 2, rows, cols.length);
}

function parse_(o) {
  var out = {};
  Object.keys(o).forEach(function (k) {
    var v = o[k];
    if (v === '') return;
    if (NUMERIC[k]) out[k] = Number(v);
    else if (BOOLEAN[k]) out[k] = String(v).toUpperCase() === 'TRUE';
    else out[k] = v;
  });
  return out;
}

// ---------------------------------------------------------------- (de)serialization

function pfamToRow_(p) {
  var flat = {};
  PFAM_COLS.forEach(function (c) { flat[c] = META_FIELDS[c] ? (p.meta || {})[c] : p[c]; });
  // The sheet as last imported from Excel (lets a later Excel import tell web edits apart).
  flat.xlRef = p._xl ? JSON.stringify(p._xl) : '';
  return toRow_(flat, PFAM_COLS);
}

function taskToRow_(pfamId, t) {
  var flat = {};
  TASK_COLS.forEach(function (c) { flat[c] = t[c]; });
  flat.pfamId = pfamId;
  flat.baseStart = t.base ? t.base.start : '';
  flat.baseEnd = t.base ? t.base.end : '';
  return toRow_(flat, TASK_COLS);
}

function rowToTask_(r) {
  var t = parse_(r);
  delete t.pfamId;
  if (t.baseStart || t.baseEnd) t.base = { start: t.baseStart || null, end: t.baseEnd || null };
  delete t.baseStart;
  delete t.baseEnd;
  ['pred', 'start', 'end', 'workdays'].forEach(function (k) { if (!(k in t)) t[k] = null; });
  if (t.type === 'task') {
    if (!('lag' in t)) t.lag = 0;
    if (!('endAdj' in t)) t.endAdj = 0;
    if (!('pct' in t)) t.pct = 0;
  }
  return t;
}

function readBundle_() {
  var tasksBy = {};
  readRows_('Tasks', TASK_COLS).forEach(function (r) {
    (tasksBy[r.pfamId] = tasksBy[r.pfamId] || []).push(rowToTask_(r));
  });
  var pfams = readRows_('PFAMs', PFAM_COLS).map(function (r) {
    var p = parse_(r);
    p.meta = {};
    Object.keys(META_FIELDS).forEach(function (k) { p.meta[k] = p[k] || ''; delete p[k]; });
    p.version = p.version || 0;
    p.hidden = !!p.hidden;
    p.tasks = tasksBy[p.id] || [];
    if (p.xlRef) {
      try { p._xl = JSON.parse(p.xlRef); } catch (ignore) {}
    }
    delete p.xlRef;
    return p;
  });
  pfams.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

  var calendars = {};
  readRows_('Holidays', HOLIDAY_COLS).forEach(function (r) {
    var c = calendars[r.site] = calendars[r.site] || { site: r.site, holidays: [] };
    c.holidays.push({ date: r.date, name: r.name });
  });

  var meta = {};
  readRows_('Meta', META_COLS).forEach(function (r) { meta[r.key] = r.value; });
  var source = {};
  try { source = JSON.parse(meta.source || '{}'); } catch (ignore) {}

  return { schema: 1, source: source, calendars: calendars, pfams: pfams };
}

// ---------------------------------------------------------------- writes

function importAll_(data) {
  if (!data || !data.pfams) throw new Error('importAll: missing data.pfams');
  var taskRows = [];
  var pfamRows = data.pfams.map(function (p, i) {
    p.version = (p.version || 0) + 1;
    if (p.order == null) p.order = i + 1;
    (p.tasks || []).forEach(function (t) { taskRows.push(taskToRow_(p.id, t)); });
    return pfamToRow_(p);
  });
  rewrite_('PFAMs', PFAM_COLS, pfamRows);
  rewrite_('Tasks', TASK_COLS, taskRows);
  writeHolidays_(data.calendars || {});
  rewrite_('Meta', META_COLS, [['source', JSON.stringify(data.source || {})], ['importedAt', new Date().toISOString()]]);
  var versions = {};
  data.pfams.forEach(function (p) { versions[p.id] = p.version; });
  return { ok: true, pfams: pfamRows.length, tasks: taskRows.length, versions: versions };
}

function writeHolidays_(calendars) {
  var rows = [];
  Object.keys(calendars).forEach(function (site) {
    (calendars[site].holidays || []).forEach(function (h) { rows.push(toRow_({ site: site, date: h.date, name: h.name }, HOLIDAY_COLS)); });
  });
  rewrite_('Holidays', HOLIDAY_COLS, rows);
}

function findPfamRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function savePfam_(pfam, tasks, baseVersion) {
  if (!pfam || !pfam.id) throw new Error('savePfam: missing pfam.id');
  var psh = sheet_('PFAMs', PFAM_COLS);
  var row = findPfamRow_(psh, pfam.id);
  var current = 0;
  if (row > 0) {
    var header = psh.getRange(1, 1, 1, psh.getLastColumn()).getDisplayValues()[0];
    current = Number(psh.getRange(row, header.indexOf('version') + 1).getDisplayValue()) || 0;
  }
  if (baseVersion !== null && baseVersion !== undefined && row > 0 && Number(baseVersion) !== current) {
    return { ok: false, conflict: true, version: current };
  }
  pfam.version = current + 1;
  pfam.updatedAt = pfam.updatedAt || new Date().toISOString();
  var prow = pfamToRow_(pfam);
  if (row > 0) writeBlock_(psh, row, [prow], PFAM_COLS.length);
  else writeBlock_(psh, psh.getLastRow() + 1, [prow], PFAM_COLS.length);

  replaceTaskBlock_(pfam.id, tasks.map(function (t) { return taskToRow_(pfam.id, t); }));
  return { ok: true, version: pfam.version };
}

/** Tasks of one PFAM are kept as a contiguous block; replace it in place. */
function replaceTaskBlock_(pfamId, rows) {
  var sh = sheet_('Tasks', TASK_COLS);
  var last = sh.getLastRow();
  var ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
  var first = ids.indexOf(pfamId);
  var lastIdx = ids.lastIndexOf(pfamId);

  if (first < 0) {
    writeBlock_(sh, last + 1, rows, TASK_COLS.length);
    return;
  }
  for (var i = first; i <= lastIdx; i++) {
    if (ids[i] !== pfamId) {
      // Block was split (sheet sorted by hand): rebuild the whole sheet.
      var keep = readRows_('Tasks', TASK_COLS).filter(function (r) { return r.pfamId !== pfamId; })
        .map(function (r) { return TASK_COLS.map(function (c) { return cell_(r[c]); }); });
      rewrite_('Tasks', TASK_COLS, keep.concat(rows));
      return;
    }
  }
  var oldCount = lastIdx - first + 1;
  var startRow = first + 2;
  if (rows.length > oldCount) sh.insertRowsAfter(startRow + oldCount - 1, rows.length - oldCount);
  else if (rows.length < oldCount) deleteRowsSafe_(sh, startRow + rows.length, oldCount - rows.length);
  writeBlock_(sh, startRow, rows, TASK_COLS.length);
}

/** Sheets refuses to delete every non-frozen row; keep a spare blank row first. */
function deleteRowsSafe_(sh, start, count) {
  if (sh.getMaxRows() - count < 2) sh.insertRowsAfter(sh.getMaxRows(), 1);
  sh.deleteRows(start, count);
}

function deletePfam_(id) {
  var psh = sheet_('PFAMs', PFAM_COLS);
  var row = findPfamRow_(psh, id);
  if (row > 0) deleteRowsSafe_(psh, row, 1);
  replaceTaskBlock_(id, []);
  return { ok: true };
}

/** Run once from the editor to create the sheets (optional; they are also created on demand). */
function setup() {
  sheet_('PFAMs', PFAM_COLS);
  sheet_('Tasks', TASK_COLS);
  sheet_('Holidays', HOLIDAY_COLS);
  sheet_('Meta', META_COLS);
}
