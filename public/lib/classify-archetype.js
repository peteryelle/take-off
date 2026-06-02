// classify-archetype.js — pure archetype router for the schedule layer.
// No PDF, no DOM, no network, no LLM.
//
// Three AEs proved the "schedule" is not one structure. This module looks at a
// sheet's tables + token statistics and decides WHICH reader should handle it,
// so nothing downstream has to assume a job looks like QTS:
//
//   'device_list'     -> row-per-device table (QTS security schedule, APG cabinet
//                        schedule). Has a UIN/TAG/EQUIPMENT-ID column; rows are
//                        individual devices. Routes to the device-list reader.
//   'quantity_matrix' -> count-by-type matrix (APG OUTLET QUANTITY SCHEDULE).
//                        A type column + a quantity column + a grand-total row;
//                        NO per-device rows. Routes to the matrix reader.
//   'label_stamp'     -> no countable schedule table; identity lives in repeated
//                        plan stamps (VA N2/DV/DD, APG SF1 outlets). Routes to
//                        detect.js anchor counting.
//
// The classifier is deliberately conservative: it reports a winner with a score
// and the runner-up, and never forces a choice it can't justify (returns
// 'unknown' with reasons, which the app surfaces as "route to review" rather
// than guessing — the silent-miscount guard).

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');

// Header vocabulary, by archetype. These are recognition hints, not hard
// requirements — discovery still learns the AE's exact wording per job.
const DEVICE_ID_HEADERS = [/^UIN$/, /^TAG$/, /^DEVICE\s*ID$/, /^EQUIPMENT\s*ID$/, /^OUTLET\s*ID$/, /^ITEM$/];
const QTY_HEADERS = [/\bQUANTITY\b/, /\bQTY\b/, /\bGRAND\s*TOTAL\b/, /\bTOTAL\b/];
const TYPE_HEADERS = [/^TYPE$/, /OUTLET\s*TYPE/, /DEVICE\s*TYPE/, /^DESIGNATOR$/];
const GRAND_TOTAL = /\bGRAND\s*TOTAL\b/;

const anyMatch = (s, res) => res.some((re) => re.test(s));

/**
 * Classify ONE table.
 * @param {Object} table
 *   { headers: [str], rows?: [[str]], hasGrandTotalRow?: bool,
 *     idColumnValues?: [str] }  // values under the device-id column, if any
 * @returns {{ archetype, score, reasons:[str] }}
 */
export function classifyTable(table = {}) {
  const headers = (table.headers || []).map(norm);
  const reasons = [];

  const hasDeviceId = headers.some((h) => anyMatch(h, DEVICE_ID_HEADERS));
  const hasQty = headers.some((h) => anyMatch(h, QTY_HEADERS));
  const hasType = headers.some((h) => anyMatch(h, TYPE_HEADERS));
  const hasGrandTotal = !!table.hasGrandTotalRow || headers.some((h) => GRAND_TOTAL.test(h));

  // device-list: an id column whose values are distinct per row (real UINs/tags),
  // not a short closed set of type codes.
  const idVals = (table.idColumnValues || []).map(norm).filter(Boolean);
  const distinctId = new Set(idVals).size;
  const idLooksPerDevice = idVals.length > 0 && distinctId / idVals.length > 0.8;

  let device_list = 0, quantity_matrix = 0;

  if (hasDeviceId) { device_list += 2; reasons.push('has device-id column header'); }
  if (idLooksPerDevice) { device_list += 2; reasons.push(`id column is per-row distinct (${distinctId}/${idVals.length})`); }

  if (hasType && hasQty) { quantity_matrix += 2; reasons.push('type column + quantity column'); }
  if (hasGrandTotal) { quantity_matrix += 2; reasons.push('grand-total row present'); }
  // A matrix's "type" column is a small closed set repeated, the opposite of per-device.
  if (idVals.length > 0 && distinctId / idVals.length <= 0.5) {
    quantity_matrix += 1; reasons.push('type column is a small repeated set');
  }
  // A device-id column is decisive against matrix unless a grand total clearly wins.
  if (hasDeviceId && !hasGrandTotal) quantity_matrix -= 1;

  const scores = { device_list, quantity_matrix };
  const [winner, runnerUp] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (winner[1] <= 0 || winner[1] === (runnerUp ? runnerUp[1] : 0)) {
    return { archetype: 'unknown', score: winner[1], reasons, scores };
  }
  return { archetype: winner[0], score: winner[1], reasons, scores };
}

/**
 * Classify a whole SHEET: pick the best table archetype, or fall back to
 * label_stamp when there is no countable table but anchors stamp the plan.
 *
 * @param {Object} sheet
 *   { tables?: [tableInput], anchorTokenCount?: number, planTokenCount?: number }
 * @returns {{ archetype, route, score, reasons, perTable? }}
 */
export function classifySheet(sheet = {}) {
  const tables = sheet.tables || [];
  const perTable = tables.map(classifyTable);

  // Best non-unknown table wins the sheet.
  const ranked = perTable
    .map((r, i) => ({ ...r, index: i }))
    .filter((r) => r.archetype !== 'unknown')
    .sort((a, b) => b.score - a.score);

  if (ranked.length) {
    const best = ranked[0];
    return {
      archetype: best.archetype,
      route: ROUTE[best.archetype],
      score: best.score,
      reasons: best.reasons,
      tableIndex: best.index,
      perTable,
    };
  }

  // No countable table. If anchors stamp the plan densely, it's a label-stamp sheet.
  const anchors = sheet.anchorTokenCount || 0;
  if (anchors > 0) {
    return {
      archetype: 'label_stamp',
      route: ROUTE.label_stamp,
      score: anchors,
      reasons: [`no countable table; ${anchors} anchor stamps on plan`],
      perTable,
    };
  }

  return { archetype: 'unknown', route: 'review', score: 0,
    reasons: ['no countable table and no plan anchors'], perTable };
}

export const ROUTE = {
  device_list: 'device_list_reader',
  quantity_matrix: 'matrix_reader',
  label_stamp: 'detect_anchor_count',
};

export default classifySheet;
