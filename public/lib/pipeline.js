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

// Derive the classifier's sheet signals from the text layer the host already
// has. Hosts (the Netlify functions, the browser pipeline) call this and pass
// the result as opts.sheetSignals so a sheet routes itself. Pure: text in,
// signals out — no PDF, no DOM.
//
//   anchorTokenCount : how many configured-anchor tokens stamp this sheet
//                      (the label_stamp signal)
//   tables           : [{ headers, idColumnValues, hasGrandTotalRow }] inferred
//                      from header-keyword rows; empty when none detected
//
// Conservative by design: it reports what it can see and lets classifySheet
// decide. No detectable table -> tables:[], which (with anchors) routes to
// label_stamp and (without) to review.
const HEADER_WORDS = /^(UIN|TAG|DEVICE|EQUIPMENT|OUTLET|ITEM|TYPE|QUANTITY|QTY|CABLE|HOMERUN|DETAIL|PORT|ROOM|DESIGNATOR|DESCRIPTION|HEIGHT|GRAND|TOTAL)$/i;

export function deriveSheetSignals(textItems = [], deviceTypes = []) {
  const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');

  // anchor token count: tokens matching any configured anchor matcher.
  let anchorTokenCount = 0;
  const matchers = [];
  for (const dt of deviceTypes) {
    const cfg = dt.detection_config;
    if (!cfg || !cfg.anchor) continue;
    if (cfg.anchor_mode === 'regex' || cfg.uin_pattern) {
      try { const re = new RegExp(cfg.uin_pattern || cfg.anchor); matchers.push((s) => re.test(s)); } catch { /* skip bad pattern */ }
    } else {
      const A = norm(cfg.anchor); matchers.push((s) => s === A);
    }
  }
  if (matchers.length) {
    for (const it of textItems) {
      const s = norm(it.str);
      if (s && matchers.some((m) => m(s))) anchorTokenCount++;
    }
  }

  // Header-row detection: group by y, find rows that are mostly header words.
  const rowTol = 0.006;
  const sorted = [...textItems].filter((it) => it.cy_norm != null).sort((a, b) => a.cy_norm - b.cy_norm);
  const rows = [];
  let cur = [], lastY = null;
  for (const it of sorted) {
    if (lastY == null || Math.abs(it.cy_norm - lastY) <= rowTol) cur.push(it);
    else { rows.push(cur); cur = [it]; }
    lastY = it.cy_norm;
  }
  if (cur.length) rows.push(cur);

  const hasGrandTotalRow = textItems.some((it) => /grand/i.test(it.str))
    && textItems.some((it) => /total/i.test(it.str));

  const tables = [];
  for (const row of rows) {
    const words = row.map((it) => norm(it.str)).filter(Boolean);
    if (words.length < 2) continue;
    const headerHits = words.filter((w) => HEADER_WORDS.test(w)).length;
    if (headerHits >= 2 && headerHits / words.length >= 0.4) {
      const idHeader = row.find((it) => /^(UIN|TAG|DEVICE\s*ID|EQUIPMENT\s*ID|OUTLET\s*ID|ITEM|TYPE)$/i.test(norm(it.str)));
      let idColumnValues = [];
      if (idHeader) {
        idColumnValues = textItems
          .filter((it) => it.cy_norm > row[0].cy_norm + rowTol
            && Math.abs(it.cx_norm - idHeader.cx_norm) <= 0.03)
          .map((it) => norm(it.str)).filter(Boolean).slice(0, 300);
      }
      tables.push({ headers: words, idColumnValues, hasGrandTotalRow });
    }
  }

  return { tables, anchorTokenCount };
}

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
  } else {
    // No explicit schedule config: classify the sheet to route it. Signals are
    // either supplied by the host or derived here from the text layer.
    const signals = opts.sheetSignals || deriveSheetSignals(textItems, deviceTypes);
    routeInfo = classifySheet(signals);
    archetype = routeInfo.archetype;
    if (archetype === 'device_list') {
      scheduleRows = parseSchedule(textItems, opts.scheduleCfg || scheduleCfg || {}, opts);
    } else if (archetype === 'quantity_matrix') {
      const matrix = parseMatrix(textItems, opts.matrixCfg || {}, opts);
      scheduleRows = matrixRowsToScheduleRows(matrix, opts.typeAliases || {});
      routeInfo.matrix = { total: matrix.total, grand_total: matrix.grand_total, ties: matrix.ties, warnings: matrix.warnings };
      labelsForReconcile = [];
    }
    // label_stamp / unknown: scheduleRows stays [], labels drive the count.
  }

  const devices = reconcile(catalog, labelsForReconcile, symbolInstances, scheduleRows, opts, leaderOverrides);

  return { devices, labelInstances, scheduleRows, symbolInstances, leaderOverrides, typeMap, archetype, routeInfo };
}

export default buildDeviceList;
