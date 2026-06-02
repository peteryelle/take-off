// matrix-schedule.js — pure reader for the quantity-matrix archetype.
// No PDF, no DOM, no network.
//
// Some AEs (APG) express device counts as a matrix, not a per-device list:
//
//   OUTLET TYPE | OUTLET QUANTITY | POTS/POTN QTY | NIPR QTY | ... | BLANK
//   1           | 26              | 26            | 26       | ... | 52
//   SF1         | 62              | 62            | 62       | ... | 0
//   TV          | 12             ...
//   Grand total | 113            ...
//
// There are no device rows to anchor on — the counts are pre-aggregated. This
// reader locates the TYPE column and the primary QUANTITY column by header
// position, reads one count per type row, and verifies the per-type sum against
// the grand-total row. That cross-check is the gate: a reader can hit the total
// by luck while dropping a high-count row (the SF1 trap), so we assert both.
//
// Returns { rows:[{type, quantity}], total, grand_total, ties } where `ties`
// is whether the per-type sum equals the stated grand total — the trust signal
// the app surfaces to the user.

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
const isInt = (s) => /^\d+$/.test(String(s).trim());

// Group normalized text items into visual rows. Greedy y-chaining merges rows
// when stray tokens land at intermediate y's, so we bin by row center: an item
// joins an existing row only if within rowTol of that row's mean y, else starts
// a new row. This keeps tightly but evenly spaced matrix rows separate.
function groupRows(items, rowTol) {
  const sorted = [...items].sort((a, b) => a.cy_norm - b.cy_norm);
  const rows = [];
  for (const it of sorted) {
    let placed = false;
    for (const r of rows) {
      if (Math.abs(it.cy_norm - r.cy) <= rowTol) {
        r.items.push(it);
        r.sum += it.cy_norm; r.cy = r.sum / r.items.length;
        placed = true; break;
      }
    }
    if (!placed) rows.push({ cy: it.cy_norm, sum: it.cy_norm, items: [it] });
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((r) => r.items.sort((a, b) => a.cx_norm - b.cx_norm));
}

/**
 * @param {Array}  textItems [{ str, cx_norm, cy_norm }] for the matrix sheet
 * @param {Object} cfg  { typeHeader?, qtyHeader?, types?:[str] }
 *   typeHeader/qtyHeader: header wording to locate columns (defaults cover APG)
 *   types: optional allow-list of valid type codes (kills stray rows). When the
 *          AE's type set is known from discovery, pass it; otherwise any row
 *          whose first cell is a short code + has an integer in the qty column
 *          is accepted.
 * @param {Object} opts { rowTol, colTol }
 * @returns {{ rows, total, grand_total, ties, warnings }}
 */
export function parseMatrix(textItems = [], cfg = {}, opts = {}) {
  const rowTol = opts.rowTol ?? 0.004;
  const colTol = opts.colTol ?? 0.04;
  const typeHeaderRe = cfg.typeHeader ? new RegExp(cfg.typeHeader, 'i') : /OUTLET\s*TYPE|^TYPE$|DEVICE\s*TYPE|DESIGNATOR/i;
  const qtyHeaderRe = cfg.qtyHeader ? new RegExp(cfg.qtyHeader, 'i') : /OUTLET\s*QUANTITY|^QUANTITY$|^QTY$/i;
  const allow = Array.isArray(cfg.types) && cfg.types.length ? new Set(cfg.types.map(norm)) : null;
  const warnings = [];

  const rows = groupRows(textItems, rowTol);

  // 1. Locate columns by header WORDS, not by a single header row — real matrix
  //    headers span multiple stacked rows ("OUTLET TYPE" on one line, the
  //    "QUANTITY" sub-headers on the line above). The TYPE column x is the
  //    "TYPE" header token; the primary QUANTITY column x is the QUANTITY token
  //    nearest-and-right-of the TYPE column (leftmost quantity = OUTLET QUANTITY,
  //    before the POTS/NIPR/SIPR/BLANK sub-columns).
  const typeTok = textItems.find((it) => /^TYPE$/i.test(it.str))
    || textItems.find((it) => typeHeaderRe.test(norm(it.str)));
  if (!typeTok) {
    return { rows: [], total: 0, grand_total: null, ties: false,
      warnings: ['matrix TYPE column header not found'] };
  }
  const typeX = typeTok.cx_norm;
  const headerY = typeTok.cy_norm;
  const qToks = textItems
    .filter((it) => /^QUANTITY$|^QTY$/i.test(it.str) && it.cx_norm > typeX)
    .sort((a, b) => a.cx_norm - b.cx_norm);
  if (!qToks.length) {
    return { rows: [], total: 0, grand_total: null, ties: false,
      warnings: ['matrix QUANTITY column header not found'] };
  }
  const qtyX = qToks[0].cx_norm;
  // Data rows sit just below the header. Header sub-labels (QUANTITY/POTS/NIPR…)
  // cluster within a small y-window of the TYPE header; the SAME words recur far
  // below as cabinet-schedule values, so bound the band to a tight window rather
  // than the max over the whole sheet.
  const HEADER_WINDOW = 0.04;
  const headerBandBottom = Math.max(
    headerY,
    ...textItems.filter((it) =>
      /^(OUTLET|TYPE|QUANTITY|QTY|POTS|POTN|NIPR|SIPR|BLANK|DATA|VOIP)$/i.test(it.str)
      && Math.abs(it.cx_norm - typeX) < 0.5
      && it.cy_norm >= headerY - HEADER_WINDOW
      && it.cy_norm <= headerY + HEADER_WINDOW).map((it) => it.cy_norm),
  );

  // 2. Read data rows below the header band. A type cell must sit in the type
  //    column (within colTol of typeX); its quantity is the integer nearest qtyX
  //    in the same visual row. The column constraint rejects the drawing's grid
  //    ticks (1..20 along the border) and title-block A/B that share the codes.
  const out = [];
  let grand_total = null;
  let sawGrandTotal = false;
  for (const row of rows) {
    if (row[0].cy_norm <= headerBandBottom + rowTol / 2) continue;   // header and above
    const joined = norm(row.map((it) => it.str).join(' '));
    const gtMatch = joined.match(/GRAND\s*TOTAL:?\s*(\d+)/);
    if (gtMatch) { grand_total = parseInt(gtMatch[1], 10); sawGrandTotal = true; continue; }
    if (sawGrandTotal) break;   // matrix ends at grand-total row; stop before cabinet schedule

    // Type cell: an item in the type column AND left of the quantity column.
    // This admits numeric type codes (1, 3, 4, 5) — valid here — while the
    // left-of-qty constraint stops a quantity integer being read as a type.
    const typeCell = row.find((it) =>
      Math.abs(it.cx_norm - typeX) <= colTol && it.cx_norm < qtyX - colTol / 2);
    if (!typeCell) continue;
    const type = norm(typeCell.str);
    if (!type) continue;
    if (allow && !allow.has(type)) continue;
    if (!/^[A-Z0-9]{1,4}$/.test(type)) continue;            // short code: 1, SF1, TV, A

    // Quantity: nearest integer to the qty column that lies strictly RIGHT of
    // the type cell (a numeric type code sits at/left of the type column, so it
    // can never be chosen). Guards floors where the qty header x and the first
    // data column x diverge.
    const ints = row.filter((it) => isInt(it.str) && it.cx_norm > typeCell.cx_norm + colTol / 2);
    if (!ints.length) continue;
    const q = ints.sort((a, b) => Math.abs(a.cx_norm - qtyX) - Math.abs(b.cx_norm - qtyX))[0];
    out.push({ type, quantity: parseInt(q.str, 10) });
  }

  // 3. Collapse any duplicate type rows (defensive), then cross-check.
  const merged = {};
  for (const r of out) merged[r.type] = (merged[r.type] || 0) + r.quantity;
  const finalRows = Object.entries(merged).map(([type, quantity]) => ({ type, quantity }));
  const total = finalRows.reduce((s, r) => s + r.quantity, 0);
  const ties = grand_total != null && total === grand_total;
  if (grand_total != null && !ties) {
    warnings.push(`per-type sum ${total} != grand total ${grand_total} — a type row may be missing or misread`);
  }
  return { rows: finalRows, total, grand_total, ties, warnings };
}

export default parseMatrix;
