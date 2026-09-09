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
// Verified against real PDF.js-style text extraction from an actual T-500
// sheet (Gainesville EHRM), not a hand-built fixture — three things a
// synthetic fixture got wrong, all fixed here:
//
// 1. Headers do NOT wrap uniformly. "BUILDING NUMBER" is a single span;
//    "TELECOMMUNICATIONS" / "ROOM NUMBER" wraps to two lines. Header
//    detection has to tolerate a mix, not assume every column wraps.
// 2. Adjacent header columns can be as little as ~0.027 (normalized x) apart
//    — tighter than a generous tolerance allows, risking two neighboring
//    columns (or a column and the very next data row) merging into one.
// 3. Header text is NOT x-aligned with the data column below it — on the
//    real sheet, header labels sit centered/offset from their data by
//    roughly 0.01–0.017, enough to flip which header a data value reads as
//    "nearest to" right at a column boundary.
//
// (3) is why this reader does NOT assign data cells by nearest-header-x
// (schedule.js's approach, fine for its own case). Instead: the header is
// used only to find where the table starts and the true left-to-right KEY
// ORDER of the configured columns. Each data row's own cells are then
// assigned POSITIONALLY — sorted left-to-right within that row and zipped
// against the header's key order. This sidesteps the offset entirely: a
// row's own items are always in clean left-to-right sequence relative to
// each other, however the header text happens to sit above them. A row
// whose item count doesn't match the configured column count is skipped
// (flag/skip, not guessed) — this is also what naturally excludes the
// footer notes block (a wrapped paragraph breaks into far more than 5
// word-tokens per line) and the sheet's other table (Camera Schedule),
// which is also excluded up front by the x-bound spatial filter below.

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

// Group items into columns by x proximity (mirrors groupRows, transposed).
// Default colTol is deliberately tight (~half the smallest real adjacent
// column gap seen on T-500, ~0.027) so neighboring columns never merge.
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
// span more than one visual row (a column that wraps). Columns are grouped
// by x first, each column's items joined top-to-bottom by y, then compared
// against the target label — requires an EXACT match, which is what lets a
// too-wide band safely fail rather than silently swallow stray text.
function headerXBand(bandItems, label, colTol) {
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
 *     building?, level? }, tolerances?: { rowTol, colTol, headerBandTol } }
 *   tolerances are calibrated PER AE FORMAT (Discovery's job, once, on that
 *   AE's first TR-schedule sheet) and persisted alongside locator/columns —
 *   not hardcoded here. A different AE's font size or table density can
 *   easily shift real line-pitch and column-spacing enough to need different
 *   numbers than VA's T-500 (see file header for how tight those margins
 *   already are on just this one sheet). Falls back to opts, then to
 *   VA-shaped defaults, for direct/test callers that don't have a calibrated
 *   config yet.
 * @param {Object} opts  { rowTol, colTol, headerBandTol } — back-compat /
 *   direct-call override, lower priority than trScheduleCfg.tolerances.
 *   rowTol: y-tolerance for DATA rows (single-line, tight spacing). ~0.008.
 *     NOT 0.010 -- on the real T-500 sheet, the last data row (J527-1) sits
 *     only 0.0093 from the footer notes block's first line. 0.010 chain-merges
 *     them into one row, fails the exact-column-count check, and silently
 *     drops that entire row (a real bug this shipped with briefly — caught by
 *     Discovery's auto-calibration finding a tighter, measured value than the
 *     hand-tuned default here ever was).
 *   colTol: x-tolerance for clustering header columns. Keep tight — real
 *     adjacent columns can be ~0.027 apart. Default 0.012.
 *   headerBandTol: y-window searched together for HEADER labels, to catch a
 *     wrapped column without reaching into the first data row. Real header
 *     line-wrap gaps are ~0.005 — default 0.010, NOT a multiple of rowTol
 *     (data rows are spaced further apart than header line-wraps are, so
 *     reusing rowTol's scale here was what let the header band swallow data
 *     rows on the real sheet).
 * @returns {Array} tr_schedule_rows: [{ tr_number, building, level,
 *   total_terminations, min_patch_panels }]
 */
export function parseTrSchedule(textItems = [], trScheduleCfg = {}, opts = {}) {
  if (!trScheduleCfg || trScheduleCfg.present === false) return [];
  const cols = trScheduleCfg.columns || {};
  if (!cols.tr_number || !cols.terminations || !cols.patch_panels) return [];

  const tol = trScheduleCfg.tolerances || {};
  const rowTol = tol.rowTol ?? opts.rowTol ?? 0.008;
  const colTol = tol.colTol ?? opts.colTol ?? 0.012;
  const headerBandTol = tol.headerBandTol ?? opts.headerBandTol ?? 0.010;

  const colDefs = [
    { key: 'tr_number', label: cols.tr_number },
    { key: 'terminations', label: cols.terminations },
    { key: 'patch_panels', label: cols.patch_panels },
    ...(cols.building ? [{ key: 'building', label: cols.building }] : []),
    ...(cols.level ? [{ key: 'level', label: cols.level }] : []),
  ];

  // 1. Locate the table by its title. Real title blocks on dense schedule
  // sheets can sit closer (in y) to unrelated neighboring content — sheet
  // grid-reference marks, another table's header — than the table's own
  // header lines sit from each other. Chain-based row-grouping (comparing
  // each item only to the previous one, not to where a row started) will
  // silently merge all of that into one run-away "row" on a sheet like
  // T-500. So this does NOT use groupRows: it scans items directly for a
  // contiguous run (in reading order) whose joined text contains the title,
  // and uses THAT run's own y — never an arbitrary re-sorted row member.
  const title = titleFromLocator(trScheduleCfg.locator);
  let region = textItems;
  if (title) {
    const ordered = [...textItems].sort((a, b) => a.cy_norm - b.cy_norm || a.cx_norm - b.cx_norm);
    let titleY = null;
    for (let i = 0; i < ordered.length && titleY == null; i++) {
      let joined = '';
      for (let n = 0; n < 12 && i + n < ordered.length; n++) {
        joined = norm(joined + ' ' + ordered[i + n].str);
        if (joined.includes(title)) { titleY = ordered[i].cy_norm; break; }
      }
    }
    if (titleY == null) return [];                 // locator not found -> nothing to parse
    region = textItems.filter((it) => it.cy_norm > titleY + rowTol / 2);
  }

  // 2. Find the header band. Candidate start-points are each item's own y
  // directly (not chain-grouped rows, for the same reason as step 1 — this
  // region still contains the Camera Schedule and page-border marks at
  // similar y to the real header). headerXBand's own exact-match requirement
  // is what rejects a wrong candidate; trying every literal y is cheap at
  // real page-text volumes and avoids re-introducing the chain-merge bug.
  if (!region.length) return [];
  const candidateYs = [...new Set(region.map((it) => it.cy_norm))].sort((a, b) => a - b);

  let headerXs = null, headerBottomY = null;
  for (const bandTopY of candidateYs) {
    const band = region.filter((it) => it.cy_norm >= bandTopY && it.cy_norm <= bandTopY + headerBandTol);
    const xs = colDefs.map((c) => ({ ...c, x: headerXBand(band, c.label, colTol) }));
    const required = xs.filter((c) => c.key === 'tr_number' || c.key === 'terminations' || c.key === 'patch_panels');
    if (required.every((c) => c.x != null)) {
      // Sort by x ascending -> the table's true left-to-right column order.
      // Data rows are matched against this ORDER, not against these x values
      // directly (header text sits offset from its own data column on the
      // real sheet — see file header).
      headerXs = xs.filter((c) => c.x != null).sort((a, b) => a.x - b.x);
      headerBottomY = Math.max(...band.map((it) => it.cy_norm));
      break;
    }
  }
  if (!headerXs) return [];

  // 3. Spatially bound the table to the header's own x-extent (+ margin).
  // This is what excludes the sheet's other table (T-500's Camera Schedule
  // sits well to the right) and page-border content (sheet grid-reference
  // letters at the far left/right edges) BEFORE row-grouping ever runs —
  // without it, a "row" is just everything at a similar y ANYWHERE on the
  // page, regardless of x, and unrelated content bleeds in.
  const margin = colTol * 2;
  const minX = Math.min(...headerXs.map((c) => c.x)) - margin;
  const maxX = Math.max(...headerXs.map((c) => c.x)) + margin;

  // 4. Parse data rows below the header band, positionally.
  const dataRegion = region.filter((it) =>
    it.cy_norm > headerBottomY + rowTol / 2 && it.cx_norm >= minX && it.cx_norm <= maxX
  );
  const dataRows = groupRows(dataRegion, rowTol);

  const out = [];
  for (const row of dataRows) {
    // A real TR row has exactly one token per configured column, already in
    // left-to-right order (row is pre-sorted by x in groupRows). A mismatched
    // count means this "row" isn't a real data row (e.g. a footer-notes line
    // that happened to fall inside the x-bound) — skip rather than guess.
    if (row.length !== headerXs.length) continue;

    const cell = {};
    headerXs.forEach((c, idx) => { cell[c.key] = norm(row[idx].str).trim(); });

    const trNumber = cell.tr_number || null;
    const terminations = toInt(cell.terminations);
    const patchPanels = toInt(cell.patch_panels);

    // Validity gate: both numeric columns must parse cleanly. Catches any
    // remaining stray row that happened to match the column count by
    // coincidence.
    if (!trNumber || terminations == null || patchPanels == null) continue;

    out.push({
      tr_number: trNumber,
      building: cell.building || null,
      level: cell.level || null,
      total_terminations: terminations,
      min_patch_panels: patchPanels,
    });
  }

  return out;
}

export default parseTrSchedule;
