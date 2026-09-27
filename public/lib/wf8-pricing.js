// public/lib/wf8-pricing.js
// WF8 pass 2 — parts, assemblies and prices. Pure (no DOM, no network).
//
// A BOM item (one of the model's `items`, e.g. key "wf6:CN1", unit "ea") can have an
// assembly: lines of { part_number, qty, waste } — the parts it takes PER UNIT of the item
// (per foot when the item is in feet). Parts come from the project's catalog:
// { part_number, manufacturer, description, unit, unit_cost, labor_min }.
//
// An item is priced only when EVERY line's part has a unit cost. Anything missing stays
// blank (never $0) and is listed — the same rule the old pricing layer used.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// → Map key → { status, unit_cost, labor_min, lines:[{part_number, qty, waste, part, cost, labor}], missing:[...] }
export function priceItems(items = [], assemblies = [], parts = []) {
  const partBy = new Map(parts.map((p) => [String(p.part_number).trim(), p]));
  const linesBy = new Map();
  for (const a of assemblies) { if (!linesBy.has(a.item_key)) linesBy.set(a.item_key, []); linesBy.get(a.item_key).push(a); }
  const out = new Map();
  for (const it of items) {
    const lines = linesBy.get(it.key) || [];
    if (!lines.length) { out.set(it.key, { status: 'none', unit_cost: null, labor_min: null, lines: [], missing: [] }); continue; }
    let cost = 0, labor = 0, laborKnown = true;
    const missing = [];
    const detail = lines.map((l) => {
      const p = partBy.get(String(l.part_number).trim()) || null;
      const mult = Number(l.qty) * Number(l.waste || 1);
      const c = p && num(p.unit_cost) != null ? num(p.unit_cost) * mult : null;
      const lm = p && num(p.labor_min) != null ? num(p.labor_min) * mult : null;
      if (c == null) missing.push(p ? `${l.part_number} (no price)` : `${l.part_number} (not in catalog)`);
      else cost += c;
      if (lm == null) laborKnown = false; else labor += lm;
      return { part_number: l.part_number, qty: Number(l.qty), waste: Number(l.waste || 1), part: p, cost: c, labor: lm };
    });
    out.set(it.key, {
      status: missing.length ? 'partial' : 'priced',
      unit_cost: missing.length ? null : round(cost),
      labor_min: laborKnown ? round(labor) : null,
      lines: detail, missing,
    });
  }
  return out;
}

export function pricingSummary(items, priced) {
  const s = { items: items.length, priced: 0, partial: 0, none: 0 };
  for (const it of items) s[priced.get(it.key)?.status || 'none']++;
  return s;
}

// Orderable parts: item qty × line qty × waste, summed per part.
export function partsList(items = [], assemblies = [], parts = []) {
  const partBy = new Map(parts.map((p) => [String(p.part_number).trim(), p]));
  const qtyBy = new Map(items.map((i) => [i.key, i]));
  const by = new Map();
  for (const a of assemblies) {
    const it = qtyBy.get(a.item_key);
    if (!it) continue;
    const pn = String(a.part_number).trim();
    const row = by.get(pn) || { part_number: pn, part: partBy.get(pn) || null, qty: 0, used_by: [] };
    row.qty += Number(it.qty) * Number(a.qty) * Number(a.waste || 1);
    row.used_by.push(it.item);
    by.set(pn, row);
  }
  return [...by.values()].map((r) => ({ ...r, qty: round(r.qty, 2) })).sort((a, b) => a.part_number.localeCompare(b.part_number, undefined, { numeric: true }));
}

// ── import workbook ──
export const PART_COLS = ['part_number', 'manufacturer', 'description', 'unit', 'unit_cost', 'labor_min', 'category', 'source_url', 'notes'];
export const ASM_COLS = ['item_key', 'bom_item', 'item_unit', 'part_number', 'qty', 'waste', 'note'];

const clean = (v) => (v == null ? '' : typeof v === 'object' && 'result' in v ? String(v.result ?? '') : typeof v === 'object' && 'text' in v ? String(v.text) : String(v)).trim();

// rows: arrays of cell values with a header row first (as read from a sheet).
function objects(rows) {
  const [head, ...body] = rows;
  const keys = (head || []).map((h) => clean(h).toLowerCase().replace(/\s+/g, '_'));
  return body.map((r, i) => ({ row: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, r[j]])) }));
}

// → { parts:[...], assemblies:[...], errors:[...], replace_items:[item_key...] }
export function parseImport({ partsRows = [], assemblyRows = [] }, knownItemKeys = null) {
  const errors = [];
  const parts = [];
  const seen = new Set();
  for (const r of objects(partsRows)) {
    const pn = clean(r.part_number);
    if (!pn && !clean(r.description) && !clean(r.unit_cost)) continue;          // blank row
    if (!pn) { errors.push(`Parts row ${r.row}: part number is empty`); continue; }
    if (seen.has(pn)) { errors.push(`Parts row ${r.row}: ${pn} appears twice`); continue; }
    seen.add(pn);
    const cost = clean(r.unit_cost) === '' ? null : Number(clean(r.unit_cost).replace(/[$,]/g, ''));
    const lab = clean(r.labor_min) === '' ? null : Number(clean(r.labor_min));
    if (cost != null && !(cost >= 0)) { errors.push(`Parts row ${r.row}: ${pn} unit cost "${clean(r.unit_cost)}" is not a number`); continue; }
    if (lab != null && !(lab >= 0)) { errors.push(`Parts row ${r.row}: ${pn} labor minutes "${clean(r.labor_min)}" is not a number`); continue; }
    parts.push({ part_number: pn, manufacturer: clean(r.manufacturer) || null, description: clean(r.description) || null,
      unit: clean(r.unit) || 'ea', unit_cost: cost, labor_min: lab, category: clean(r.category) || null,
      source_url: clean(r.source_url) || null, notes: clean(r.notes) || null });
  }
  const assemblies = [];
  const seenLine = new Set();
  const filledItems = new Set();
  for (const r of objects(assemblyRows)) {
    const key = clean(r.item_key), pn = clean(r.part_number);
    if (!key) continue;
    if (!pn) continue;                                                          // blank slot to fill
    if (knownItemKeys && !knownItemKeys.has(key)) { errors.push(`Assemblies row ${r.row}: item "${key}" is not a BOM item of this project`); continue; }
    const qty = clean(r.qty) === '' ? 1 : Number(clean(r.qty));
    const waste = clean(r.waste) === '' ? 1 : Number(clean(r.waste));
    if (!(qty >= 0)) { errors.push(`Assemblies row ${r.row}: qty "${clean(r.qty)}" is not a number`); continue; }
    if (!(waste >= 1)) { errors.push(`Assemblies row ${r.row}: waste "${clean(r.waste)}" must be 1 or more (1.05 = 5% waste)`); continue; }
    const k = key + '|' + pn;
    if (seenLine.has(k)) { errors.push(`Assemblies row ${r.row}: ${pn} listed twice for ${key}`); continue; }
    seenLine.add(k); filledItems.add(key);
    assemblies.push({ item_key: key, item_label: clean(r.bom_item) || null, part_number: pn, qty, waste, note: clean(r.note) || null });
  }
  return { parts, assemblies, errors, replace_items: [...filledItems] };
}

// Template workbook: Parts (the catalog as it is) + Assemblies (every BOM item, existing lines or a blank slot).
export function buildTemplate(ExcelJS, items, parts, assemblies) {
  const wb = new ExcelJS.Workbook();
  const head = (ws, cols, widths) => {
    const row = ws.getRow(1);
    cols.forEach((c, i) => { const cell = row.getCell(i + 1); cell.value = c; cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F4F' } }; ws.getColumn(i + 1).width = widths[i] || 16; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const put = (ws, r, vals) => { vals.forEach((v, i) => { const c = ws.getRow(r).getCell(i + 1); c.value = v ?? null; c.font = { name: 'Arial', size: 10 }; }); };
  const info = wb.addWorksheet('Read me');
  [
    'Parts and assemblies import for Take-off (WF8 · Parts & prices).',
    'Parts sheet: one row per part. part_number is the key; unit_cost in $, labor_min in minutes per unit. Existing parts are updated, new ones added.',
    'Assemblies sheet: the parts each BOM item takes, per unit of the item (per foot when item_unit is ft). waste is a multiplier (1.05 = 5% waste).',
    'Fill in part_number (and qty / waste) on a blank row to add a line; add rows for more parts. Keep item_key as it is.',
    'An item whose rows you filled is replaced by exactly those rows; items you left blank keep what they have.',
    'Anything without a part or a price stays blank in the BOM workbook — never $0.',
  ].forEach((t, i) => { info.getCell(i + 1, 1).value = t; info.getCell(i + 1, 1).font = { name: 'Arial', size: 10, bold: i === 0 }; });
  info.getColumn(1).width = 130;

  const ps = wb.addWorksheet('Parts');
  head(ps, PART_COLS, [18, 18, 44, 8, 11, 11, 16, 30, 30]);
  parts.forEach((p, i) => put(ps, i + 2, PART_COLS.map((c) => p[c] ?? null)));
  const as = wb.addWorksheet('Assemblies');
  head(as, ASM_COLS, [22, 48, 9, 18, 8, 8, 30]);
  const linesBy = new Map();
  for (const a of assemblies) { if (!linesBy.has(a.item_key)) linesBy.set(a.item_key, []); linesBy.get(a.item_key).push(a); }
  let r = 2;
  for (const it of items) {
    const lines = linesBy.get(it.key) || [];
    if (lines.length) for (const l of lines) put(as, r++, [it.key, it.item, it.unit, l.part_number, Number(l.qty), Number(l.waste || 1), l.note || null]);
    else put(as, r++, [it.key, it.item, it.unit, null, 1, 1, null]);
  }
  return wb;
}

// Sheet → array rows (first sheet matching a name, case-insensitive), from an ExcelJS workbook.
export function sheetRows(wb, name) {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => { const v = row.values.slice(1); rows.push(v); });
  return rows;
}
