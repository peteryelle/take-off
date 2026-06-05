// test-schedule-seed.mjs — Task B gate. Proves buildDeviceList honors host-seeded
// schedule rows (from the schedule_rows table, supplied via opts.scheduleRows) with
// precedence over text re-parse, and that a scheduled-type plan label whose UIN is
// absent from the seed is flagged not_in_schedule (the ALM-1100B case). Pure, no PDF.
// Run: node test-schedule-seed.mjs
import { buildDeviceList } from './public/lib/pipeline.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) { console.log('  PASS ', msg); }
  else { console.log('  FAIL ', msg); failures++; }
};

// FP + ALM device types, both scheduled (sources include 'schedule'), regex UINs.
const deviceTypes = [
  { id: 67, legend_id: 'FP', name: 'Fire Phone',
    detection_config: { version: 2, type: 'FP', anchor: 'FP', anchor_mode: 'regex',
      uin_pattern: '^FP-[0-9A-Z]+$', sources: ['label', 'schedule'] } },
  { id: 66, legend_id: 'ALM', name: 'Alarm',
    detection_config: { version: 2, type: 'ALM', anchor: 'ALM', anchor_mode: 'regex',
      uin_pattern: '^ALM-[0-9A-Z]+$', sources: ['label', 'schedule'] } },
];

// Plan text layer: one scheduled FP, one scheduled ALM, and ALM-1100B which is on the
// plan but NOT in the schedule seed (the discrepancy that must auto-flag).
const textItems = [
  { str: 'FP-1011',   cx_norm: 0.20, cy_norm: 0.20 },
  { str: 'ALM-2001',  cx_norm: 0.30, cy_norm: 0.30 },
  { str: 'ALM-1100B', cx_norm: 0.71, cy_norm: 0.67 },
];

// Host-seeded rows, exactly as pass-batch.js maps them out of schedule_rows.
const scheduleRows = [
  { uin: 'FP-1011',  type: 'FP',  attributes: { cable_dest: ['SDF0134'], detail_sheet: null } },
  { uin: 'ALM-2001', type: 'ALM', attributes: { cable_dest: ['SDF0134'], detail_sheet: null } },
];

console.log('Task B: host-seeded schedule rows + not_in_schedule flag:');
const out = buildDeviceList(textItems, deviceTypes, null, { scheduleRows }, [], []);
const devices = out.devices;

assert(out.archetype === 'device_list', `archetype routed to device_list (got ${out.archetype})`);
assert(out.routeInfo && out.routeInfo.source === 'seeded_rows',
  `routeInfo.source === 'seeded_rows' (got ${out.routeInfo && out.routeInfo.source})`);
assert(devices.length === 3, `3 devices: FP-1011 + ALM-2001 + ALM-1100B (got ${devices.length})`);

const fp = devices.find((d) => d.uin === 'FP-1011');
assert(fp && fp.sources.includes('schedule') && fp.sources.includes('label') && fp.confidence === 'high',
  'FP-1011 joined schedule+label, confidence high');
assert(fp && Array.isArray(fp.attributes.cable_dest) && fp.attributes.cable_dest.includes('SDF0134'),
  'FP-1011 carries cable_dest SDF0134 from the seed');

const almOk = devices.find((d) => d.uin === 'ALM-2001');
assert(almOk && almOk.confidence === 'high' && !almOk.flags.includes('not_in_schedule'),
  'ALM-2001 (in schedule) joined clean, not flagged');

const stray = devices.filter((d) => d.flags.includes('not_in_schedule'));
assert(stray.length === 1 && stray[0].uin === 'ALM-1100B',
  'ALM-1100B (on plan, not in schedule) flagged not_in_schedule');

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
