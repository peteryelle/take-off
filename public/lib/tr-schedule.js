// public/lib/tr-schedule.js — pure reader for the TR (telecom room) termination
// and hardware schedule table (e.g. T-500 "TELECOMMUNICATION ROOM TERMINATION
// AND HARDWARE SCHEDULE"). No PDF, no DOM, no network.
//
// This is NOT schedule.js. schedule.js is keyed by UIN (one row per device
// instance, placed back onto a plan). This table has no UIN and nothing to
// place — one row per TR (telecom room), each row a pre-aggregated count
// (total terminations, min patch panels) that other TRs' floor-plan devices
// route into. Output feeds the rack-instance generator, not reconcile().
//
// Reuses schedule.js's row/column-grouping approach but adds one thing
// schedule.js doesn't need: VA's real title blocks wrap column headers across
// TWO lines ("TOTAL CAT6A CABLE" / "TERMINATIONS PER TR"), so header detection
// runs over a wider band than data-row detection. Confirmed against the T-500
// sheet in the Gainesville EHRM set — every multi-word column wraps this way.
//
// Row validity gate: a real TR row has a non-empty room-number cell AND both
// numeric columns parse as integers. This is what excludes the sheet's other
// table (Camera Schedule — different column labels, never matches header
// locate) and the footer notes block below the table (prose, fails the
// integer gate) without needing a strict TR-name regex — VA's own TR names
// don't share one shape (H519-1, B050C1, EB51A, E5031, 347-12 all appear on
// the same sheet).

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
const toInt = (s) => {
  const v = String(s).replace(/[,\s]/g, '');
  return /^\d+$/.test(v) ? parseInt(v, 10) : null;
};

// Pull the table title out of a locator like: table titled 'TELECOMMUNICATION
// ROOM TERMINATION AND HARDWARE SCHEDULE'
function titleFromLocator(locator) {
  if (!locator) return null;
  const q = String(locator).match(/['"]([^'"]+)['"]/);
  if (q) return norm(q[1]);
  return norm(String(locator).replace(/^\s*table\s+titled\s+/i, ''));
}

// Group items into visual rows by y proximity (items pre-sorted by y).
function groupRows(items, rowTol) {
  const sorted = [...items].sort((a, b) => a.cy_norm - b.cy_norm);
  const rows = [];
  let cur = [];
  let lastY = null;
  for (const it of sorted) {
    if (lastY == null || Math.abs(it.cy_norm - lastY) <= rowTol) {
      cur.push(it);
    } else {
      rows.push(cur); cur = [it];
    }
    lastY = it.cy_norm;
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.cx_norm - b.cx_norm));
}

// Group band items into columns by x proximity (mirrors groupRows, transposed).
function groupCols(items, colTol) {
  const sorted = [...items].sort((a, b) => a.cx_norm - b.cx_norm);
  const cols = [];
  for (const it of sorted) {
    let placed = false;
    for (const c of cols) {
      if (Math.abs(it.cx_norm - c.cx) <= colTol) {
        c.items.push(it);
        c.sum += it.cx_norm; c.cx = c.sum / c.items.length;
        placed = true; break;
      }
    }
    if (!placed) cols.push({ cx: it.cx_norm, sum: it.cx_norm, items: [it] });
  }
  return cols;
}

// Find the x-centroid of a header label within a "band" of items that may
// span more than one visual row — VA wraps multi-word column headers across
// two lines STACKED AT THE SAME X (e.g. "BUILDING" over "NUMBER"), unlike
// schedule.js's split-header case (adjacent items on ONE line, like "CABLE
// DEST 1"). So columns are grouped by x first, each column's items joined
// top-to-bottom by y, then compared against the target label.
function headerXBand(bandItems, label, colTol = 0.03) {
  const target = norm(label);
  for (const col of groupCols(bandItems, colTol)) {
    const ordered = [...col.items].sort((a, b) => a.cy_norm - b.cy_norm);
    const joined = norm(ordered.map((it) => it.str).join(' '));
    if (joined === target) return col.cx;
  }
  return null;
}

/**
 * @param {Array}  textItems  [{ str, cx_norm, cy_norm }] for the schedule sheet
 * @param {Object} trScheduleCfg
 *   { present, locator, columns: { tr_number, terminations, patch_panels,
 *     building?, level? } }
 * @param {Object} opts  { rowTol, headerBandTol }
 *   rowTol: y-tolerance for DATA rows (single-line, tight spacing).
 *   headerBandTol: y-window searched together for HEADER labels (wider, to
 *     merge a two-line-wrapped header into one band). Defaults to 3x rowTol.
 * @returns {Array} tr_schedule_rows: [{ tr_number, building, level,
 *   total_terminations, min_patch_panels }]
 */
export function parseTrSchedule(textItems = [], trScheduleCfg = {}, opts = {}) {
  if (!trScheduleCfg || trScheduleCfg.present === false) return [];
  const cols = trScheduleCfg.columns || {};
  if (!cols.tr_number || !cols.terminations || !cols.patch_panels) return [];

  const rowTol = opts.rowTol ?? 0.010;
  const headerBandTol = opts.headerBandTol ?? rowTol * 3;

  const colDefs = [
    { key: 'tr_number', label: cols.tr_number },
    { key: 'terminations', label: cols.terminations },
    { key: 'patch_panels', label: cols.patch_panels },
    ...(cols.building ? [{ key: 'building', label: cols.building }] : []),
    ...(cols.level ? [{ key: 'level', label: cols.level }] : []),
  ];

  // 1. Locate the table by its title; keep items below it.
  const title = titleFromLocator(trScheduleCfg.locator);
  let region = textItems;
  if (title) {
    const rowsAll = groupRows(textItems, rowTol);
    let titleY = null;
    for (const r of rowsAll) {
      const joined = norm(r.map((it) => it.str).join(' '));
      if (joined.includes(title)) { titleY = r[0].cy_norm; break; }
    }
    if (titleY == null) return [];                 // locator not found -> nothing to parse
    region = textItems.filter((it) => it.cy_norm > titleY + rowTol / 2);
  }

  // 2. Find the header band: slide a headerBandTol-wide window down the region
  // (starting at each row boundary) until every required column label resolves
  // inside it. This is what tolerates a two-line-wrapped header without
  // conflating it with the first data row (data rows are far narrower than
  // headerBandTol and their numbers never match a text label).
  const rowsAll = groupRows(region, rowTol);
  if (!rowsAll.length) return [];

  let headerXs = null, headerBottomY = null;
  for (let i = 0; i < rowsAll.length; i++) {
    const bandTopY = rowsAll[i][0].cy_norm;
    const band = region.filter((it) => it.cy_norm >= bandTopY && it.cy_norm <= bandTopY + headerBandTol);
    const xs = colDefs.map((c) => ({ ...c, x: headerXBand(band, c.label) }));
    const required = xs.filter((c) => c.key === 'tr_number' || c.key === 'terminations' || c.key === 'patch_panels');
    if (required.every((c) => c.x != null)) {
      headerXs = xs.filter((c) => c.x != null);
      headerBottomY = Math.max(...band.map((it) => it.cy_norm));
      break;
    }
  }
  if (!headerXs) return [];

  // 3. Parse data rows below the header band — assign each cell to nearest
  // column x, same nearest-centroid approach as schedule.js.
  const dataRegion = region.filter((it) => it.cy_norm > headerBottomY + rowTol / 2);
  const dataRows = groupRows(dataRegion, rowTol);

  const out = [];
  for (const row of dataRows) {
    const acc = {};
    headerXs.forEach((c, idx) => { acc[idx] = []; });
    for (const it of row) {
      let best = -1, bestD = Infinity;
      headerXs.forEach((c, idx) => {
        const d = Math.abs(it.cx_norm - c.x);
        if (d < bestD) { bestD = d; best = idx; }
      });
      if (best >= 0) acc[best].push(it.str);
    }
    const cellOf = (idx) => norm(acc[idx].join(' ')).trim();

    let trNumber = null, terminations = null, patchPanels = null, building = null, level = null;
    headerXs.forEach((c, idx) => {
      const v = cellOf(idx);
      if (c.key === 'tr_number') trNumber = v || null;
      else if (c.key === 'terminations') terminations = toInt(v);
      else if (c.key === 'patch_panels') patchPanels = toInt(v);
      else if (c.key === 'building') building = v || null;
      else if (c.key === 'level') level = v || null;
    });

    // Validity gate: real TR row needs a room-number cell and both numeric
    // columns to parse cleanly. Excludes footer notes ("SEE ENLARGED DATA
    // ROOM PLANS...") and any bleed-through from a differently-shaped table
    // without relying on a TR-name regex (VA's own TR names have no single
    // consistent shape: H519-1, B050C1, EB51A, E5031, 347-12 all appear on
    // the same sheet).
    if (!trNumber || terminations == null || patchPanels == null) continue;

    out.push({
      tr_number: trNumber,
      building,
      level,
      total_terminations: terminations,
      min_patch_panels: patchPanels,
    });
  }

  return out;
}

export default parseTrSchedule;
