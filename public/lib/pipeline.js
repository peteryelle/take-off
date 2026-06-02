// pipeline.js — the live convergence. Composes the three pure modules into one
// reconciled device list, exactly as both server functions wire it.
// No PDF, no DOM, no network.
//
//   detect    -> label instances (one per anchor)
//   schedule  -> schedule rows (UIN + cable_dest + detail_sheet)
//   reconcile -> one device record per physical device, with provenance
//
// Step 7: the symbol detector feeds symbolInstances ({type,x,y}, no UIN) in as the
// trailing arg. reconcile's SNAP folds them onto same-type placed devices (no new
// record) and surfaces unmatched glyphs as no_uin-flagged devices. The default []
// preserves the label+schedule behavior for callers that don't run symbol detection.

import { detectAll } from './detect.js';
import { parseSchedule } from './schedule.js';
import { parseMatrix } from './matrix-schedule.js';
import { classifySheet } from './classify-archetype.js';
import { reconcile } from './reconcile.js';

// Expand a quantity-matrix result into per-device schedule rows reconcile can
// seed from. A matrix gives counts per type, not per-device rows, so we synth
// `quantity` UIN-less rows per type; reconcile treats them as count-authoritative
// (placed later by label/symbol proximity, or flagged no_xy if unplaced).
function matrixRowsToScheduleRows(matrix, typeAliases = {}) {
  const rows = [];
  for (const { type, quantity } of matrix.rows || []) {
    const canonical = typeAliases[type] || type;
    for (let i = 0; i < quantity; i++) {
      rows.push({ uin: null, type: canonical, attributes: { matrix_type: type, from_matrix: true } });
    }
  }
  return rows;
}

/**
 * @param {Array}  textItems       [{ str, cx_norm, cy_norm }]
 * @param {Array}  deviceTypes     [{ id, name, legend_id, detection_config }]
 * @param {Object} scheduleCfg     pages.schedule block (or null/absent)
 * @param {Object} opts            forwarded to the modules (snapR, rowTol, famRadius, ...)
 * @param {Array}  symbolInstances [{ type, x, y }] from the symbol detector (Step 7); [] when none
 * @returns {{ devices, labelInstances, scheduleRows, symbolInstances, typeMap }}
 */
export function buildDeviceList(textItems = [], deviceTypes = [], scheduleCfg = null, opts = {}, symbolInstances = [], leaderOverrides = []) {
  // type string -> the device_types row, so callers can recover id/legend_id/name.
  const typeMap = {};
  const catalog = {};
  for (const dt of deviceTypes) {
    const cfg = dt.detection_config;
    if (!cfg || !cfg.anchor) continue;
    const type = cfg.type || dt.name;
    typeMap[type] = dt;
    catalog[type] = { sources: Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['label'] };
  }

  const labelInstances = detectAll(textItems, deviceTypes, opts);

  // ROUTE: classify the sheet, then seed reconcile from the matching reader.
  //   device_list    -> parseSchedule (row-per-device, UIN join)
  //   quantity_matrix-> parseMatrix expanded to per-device rows (count-authoritative)
  //   label_stamp     -> no schedule seed; labels carry the count
  // An explicit scheduleCfg from the caller forces the device_list path (back-compat
  // for callers that already configured a schedule). opts.sheetSignals supplies the
  // classifier inputs the host derived from the PDF (tables, anchorTokenCount).
  let scheduleRows = [];
  let archetype = 'label_stamp';
  let routeInfo = null;
  let labelsForReconcile = labelInstances;
  if (scheduleCfg && scheduleCfg.present !== false) {
    archetype = 'device_list';
    scheduleRows = parseSchedule(textItems, scheduleCfg, opts);
  } else if (opts.sheetSignals) {
    routeInfo = classifySheet(opts.sheetSignals);
    archetype = routeInfo.archetype;
    if (archetype === 'device_list') {
      scheduleRows = parseSchedule(textItems, opts.scheduleCfg || scheduleCfg || {}, opts);
    } else if (archetype === 'quantity_matrix') {
      const matrix = parseMatrix(textItems, opts.matrixCfg || {}, opts);
      scheduleRows = matrixRowsToScheduleRows(matrix, opts.typeAliases || {});
      routeInfo.matrix = { total: matrix.total, grand_total: matrix.grand_total, ties: matrix.ties, warnings: matrix.warnings };
      // A quantity-matrix lives on a SCHEDULE sheet; the matrix IS the count.
      // Type codes also appear as cell/header text here, so same-sheet label hits
      // are noise that would inflate the count — suppress them. (Device positions
      // come from the plan sheets, handled as their own label_stamp pass.)
      labelsForReconcile = [];
    }
    // label_stamp / unknown: scheduleRows stays [], labels drive the count.
  }

  const devices = reconcile(catalog, labelsForReconcile, symbolInstances, scheduleRows, opts, leaderOverrides);

  return { devices, labelInstances, scheduleRows, symbolInstances, leaderOverrides, typeMap, archetype, routeInfo };
}

export default buildDeviceList;
