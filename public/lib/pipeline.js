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
import { reconcile } from './reconcile.js';

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
  const scheduleRows = parseSchedule(textItems, scheduleCfg || {}, opts);
  const devices = reconcile(catalog, labelInstances, symbolInstances, scheduleRows, opts, leaderOverrides);

  return { devices, labelInstances, scheduleRows, symbolInstances, leaderOverrides, typeMap };
}

export default buildDeviceList;
