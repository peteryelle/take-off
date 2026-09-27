// public/lib/wf5-rows.js
// WF5 TR rooms — manual entry grid. Pure (no DOM, no network): used by
// public/wf5.html, netlify/functions/wf5-rooms.js and tests/test-wf5-rows.mjs.
//
// One grid row per TR (takeoff.trs), ten columns (takeoff.tr_room_devices
// category CHECK). A blank cell = not entered (no row stored); 0 is a value.
// A room is "done" when the user stamps its done mark (takeoff.tr_room_marks).
// Ported from public/tr-device-counts.html (the old manual page).
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIES = ['rack_new', 'rack_existing', 'wire_manager', 'access_control', 'backboard',
  'cable_tray', 'camera_connection', 'ground_busbar', 'motion_sensor', 'sleeves'];

export const CATEGORY_LABEL = {
  rack_new: 'New racks', rack_existing: 'Exist racks', wire_manager: 'Wire mgr', access_control: 'Access ctrl',
  backboard: 'Backboard', cable_tray: 'Tray ft', camera_connection: 'Camera conn', ground_busbar: 'Ground bus',
  motion_sensor: 'Motion', sleeves: 'Sleeves',
};

// Everything is a unit count except cable_tray, which is feet (one decimal).
export const CATEGORY_UNIT = { cable_tray: 'ft' };

export const isCategory = (c) => CATEGORIES.includes(c);

// Typed text -> stored value. '' / null -> null (blank = not entered).
// Anything unreadable or negative -> undefined (invalid; the caller rejects it).
export function parseCell(category, raw) {
  if (raw === '' || raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (CATEGORY_UNIT[category] === 'ft') return Math.round(n * 10) / 10;
  return Number.isInteger(n) ? n : undefined;
}

// Grid rows from what the API returns.
// trs: [{ id, tr_number }]; values: [{ tr_name, category, quantity, ... }];
// marks: [{ tr_name, page_id, x_norm, y_norm }]
export function buildRows(trs, values = [], marks = []) {
  const byTr = new Map();
  for (const v of values) {
    if (!byTr.has(v.tr_name)) byTr.set(v.tr_name, {});
    byTr.get(v.tr_name)[v.category] = v.quantity == null ? null : Number(v.quantity);
  }
  const markBy = new Map(marks.map((m) => [m.tr_name, m]));
  return [...trs]
    .filter((t) => t.tr_number)
    .sort((a, b) => String(a.tr_number).localeCompare(String(b.tr_number), undefined, { numeric: true }))
    .map((t) => {
      const saved = Object.fromEntries(CATEGORIES.map((c) => [c, byTr.get(t.tr_number)?.[c] ?? null]));
      return { tr_id: t.id, tr_name: t.tr_number, saved, counts: { ...saved }, mark: markBy.get(t.tr_number) || null, checked: false };
    });
}

export const rowDirty = (r) => CATEGORIES.some((c) => (r.counts[c] ?? null) !== (r.saved[c] ?? null));

// Cells that changed since the last load. quantity null = delete that cell.
export function changedCells(rows) {
  const out = [];
  for (const r of rows) for (const c of CATEGORIES) {
    const now = r.counts[c] ?? null;
    if (now !== (r.saved[c] ?? null)) out.push({ tr_name: r.tr_name, category: c, quantity: now, page_id: r.edit_page_id ?? null, basis: r.edit_basis ?? null });
  }
  return out;
}

// Validate cells sent to the API. Returns { cells, errors }.
export function validateCells(cells, trNames) {
  const known = new Set(trNames);
  const errors = [];
  const seen = new Set();
  const out = [];
  for (const [i, c] of (cells || []).entries()) {
    if (!c || !known.has(c.tr_name)) { errors.push(`cell ${i}: unknown TR "${c?.tr_name}"`); continue; }
    if (!isCategory(c.category)) { errors.push(`cell ${i}: unknown column "${c.category}"`); continue; }
    const q = c.quantity == null ? null : parseCell(c.category, c.quantity);
    if (q === undefined) { errors.push(`${c.tr_name} ${CATEGORY_LABEL[c.category]}: "${c.quantity}" is not a valid ${CATEGORY_UNIT[c.category] === 'ft' ? 'length' : 'count'}`); continue; }
    const key = c.tr_name + '|' + c.category;
    if (seen.has(key)) { errors.push(`${c.tr_name} ${CATEGORY_LABEL[c.category]}: sent twice`); continue; }
    seen.add(key);
    out.push({ ...c, quantity: q });
  }
  return { cells: out, errors };
}

// Set one column across target rows (not saved until Save).
export function applyBulk(rows, category, value, targetFn = (r) => r.checked) {
  let n = 0;
  for (const r of rows) if (targetFn(r)) { r.counts[category] = value; n++; }
  return n;
}

// Footer numbers.
export function summary(rows) {
  const hasValue = (r) => CATEGORIES.some((c) => r.saved[c] != null);
  const done = rows.filter((r) => r.mark);
  return {
    rooms: rows.length,
    done: done.length,
    with_values: rows.filter(hasValue).length,
    done_empty: done.filter((r) => !hasValue(r)).length,          // marked done but nothing entered
    values_not_done: rows.filter((r) => !r.mark && hasValue(r)).length,
    unsaved: rows.filter(rowDirty).length,
    racks_new: rows.reduce((s, r) => s + (r.saved.rack_new || 0), 0),
    tray_ft: Math.round(rows.reduce((s, r) => s + (r.saved.cable_tray || 0), 0) * 10) / 10,
  };
}

// ── scale for the Measure tool ──
// Architectural scale labels printed under each view, e.g. 1/2" = 1'-0".
// Returns real feet per paper inch (1/2" = 1'-0" -> 2), or null.
export function feetPerInchFromLabel(label) {
  const m = String(label).match(/(\d+(?:-\d+\/\d+)?|\d+\/\d+)\s*["”″]\s*=\s*1\s*['’′]\s*-?\s*0\s*["”″]/);
  if (!m) return null;
  let inches;
  const t = m[1];
  if (/^\d+-\d+\/\d+$/.test(t)) { const [w, f] = t.split('-'); const [a, b] = f.split('/'); inches = Number(w) + Number(a) / Number(b); }
  else if (t.includes('/')) { const [a, b] = t.split('/'); inches = Number(a) / Number(b); }
  else inches = Number(t);
  return inches > 0 ? Math.round((1 / inches) * 10000) / 10000 : null;
}

// Most common scale on a sheet, from its text. { ft_per_inch, label, count } or null.
export function sheetScale(text) {
  const re = /(\d+(?:-\d+\/\d+)?|\d+\/\d+)\s*["”″]\s*=\s*1\s*['’′]\s*-?\s*0\s*["”″]/g;
  const tally = new Map();
  for (const m of String(text).matchAll(re)) {
    const f = feetPerInchFromLabel(m[0]);
    if (f == null) continue;
    const k = String(f);
    const t = tally.get(k) || { ft_per_inch: f, label: m[0].replace(/\s+/g, ' '), count: 0 };
    t.count++; tally.set(k, t);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count)[0] || null;
}

// Polyline length in feet. points in PDF points (72/in).
export function polylineFeet(points, ftPerInch) {
  let pt = 0;
  for (let i = 1; i < points.length; i++) pt += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return Math.round((pt / 72) * ftPerInch * 10) / 10;
}
