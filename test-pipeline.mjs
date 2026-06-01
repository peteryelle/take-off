// pipeline.test.js — Step 5 gate. End-to-end: detect + schedule -> reconcile,
// exactly as the server wires it. Run: node test/pipeline.test.js
import { buildDeviceList } from './public/lib/pipeline.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

// A demarc + scale so we can show distances compute on the reconciled list.
const DEMARC = { x: 0.05, y: 0.05 };
const PTS_PER_FT = 2.0, W = 1000, H = 800, ROUTE = 1.35;
function routedFt(d) {
  if (d.x == null || d.y == null) return null;
  const dx = (d.x - DEMARC.x) * W, dy = (d.y - DEMARC.y) * H;
  return parseFloat((Math.hypot(dx, dy) * ROUTE / PTS_PER_FT).toFixed(1));
}

// ─────────────────────────────────────────────────────────────────────────
// QTS: schedule + plan labels. The same 40 UINs appear BOTH in the DETAIL
// SCHEDULE table and as plan callouts -> 80 label instances + 40 schedule rows,
// all sharing 40 UINs. reconcile must fold them to 40 devices, schedule+label.
// ─────────────────────────────────────────────────────────────────────────
console.log('QTS end-to-end (schedule + label UIN join -> 40):');
{
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const X = { uin: 0.10, detail: 0.30, cab1: 0.55, cab2: 0.75 };
  const items = [];

  // plan callouts ABOVE the schedule block (y < 0.50) — the same 40 UINs
  let i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      items.push(ti(`${p}-EXT-${k}`, 0.40 + (i % 5) * 0.08, 0.10 + (i % 8) * 0.03));
      i++;
    }
  }
  // bare type tokens (no UIN) on the plan — must not be detected (uin_pattern needs the dash)
  items.push(ti('CR', 0.42, 0.35), ti('VIC', 0.5, 0.36), ti('DC', 0.55, 0.37));

  // DETAIL SCHEDULE block, isolated below its title (y >= 0.50), compact rows
  items.push(ti('DETAIL SCHEDULE', X.uin, 0.50),
             ti('UIN', X.uin, 0.51), ti('DETAIL SHEET', X.detail, 0.51),
             ti('CABLE DEST 1', X.cab1, 0.51), ti('CABLE DEST 2', X.cab2, 0.51));
  i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      const uin = `${p}-EXT-${k}`, y = 0.52 + i * 0.008;
      items.push(ti(uin, X.uin, y), ti(`SE0${(i % 6) + 1}-05`, X.detail, y), ti(`EXTIDF${(i % 6) + 1}`, X.cab1, y));
      i++;
    }
  }

  const scheduleCfg = {
    present: true, locator: "table titled 'DETAIL SCHEDULE'",
    columns: { uin: 'UIN', detail_sheet: 'DETAIL SHEET', cable_dest: ['CABLE DEST 1', 'CABLE DEST 2'] },
    type_from: 'uin_prefix',
  };
  const deviceTypes = Object.keys(spec).map((p) => ({
    id: `dt_${p}`, name: p, legend_id: `LEG_${p}`,
    detection_config: { type: p, anchor: p, anchor_mode: 'regex', uin_pattern: `^${p}-[\\w-]+$`,
                        sources: ['schedule', 'label', 'symbol'], families: [] },
  }));

  const { devices, labelInstances, scheduleRows } = buildDeviceList(items, deviceTypes, scheduleCfg, { rowTol: 0.005 });
  assert(scheduleRows.length === 40, `schedule parsed 40 rows (got ${scheduleRows.length})`);
  assert(labelInstances.length === 80, `detector found 80 UIN labels (plan + schedule cells) (got ${labelInstances.length})`);
  assert(devices.length === 40, `reconciled to 40 devices (got ${devices.length})`);
  const byType = countBy(devices, (d) => d.type);
  assert(JSON.stringify(byType) === JSON.stringify(spec), `by-type matches ${JSON.stringify(spec)} (got ${JSON.stringify(byType)})`);
  assert(devices.every((d) => d.sources.includes('schedule') && d.sources.includes('label') && d.confidence === 'high'),
    'every device has schedule+label, confidence high');
  assert(devices.every((d) => Array.isArray(d.attributes.cable_dest) && d.attributes.cable_dest.length >= 1),
    'cable_dest carried onto every reconciled device');
  assert(devices.every((d) => routedFt(d) != null), 'distances compute on the reconciled list');
}

// ─────────────────────────────────────────────────────────────────────────
// VA: label-only (no schedule). 93 faceplates, each an N2 anchor. The detection
// stream carries 2 duplicate-coordinate instances (over-emit / two-gang). gate:
// 93 devices, no duplicate rows, distances compute.
// ─────────────────────────────────────────────────────────────────────────
console.log('VA end-to-end (label-only, dupes collapse -> 93):');
{
  const items = [];
  const coords = [];
  for (let n = 0; n < 93; n++) {
    const x = parseFloat((0.08 + (n % 31) * 0.029).toFixed(4));
    const y = parseFloat((0.12 + Math.floor(n / 31) * 0.25).toFixed(4));
    coords.push([x, y]);
    items.push(ti('N2', x, y), ti('DV1', x + 0.004, y), ti(n % 3 ? 'DD2' : 'DD3', x, y + 0.005));
  }
  // 2 duplicate-coordinate N2 (exact same point as two existing faceplates)
  items.push(ti('N2', coords[10][0], coords[10][1]), ti('N2', coords[50][0], coords[50][1]));
  // distractors that must not match an exact "N2"
  items.push(ti('INSTALL', 0.9, 0.95), ti('ADDITIONAL', 0.92, 0.95), ti('N', 0.94, 0.95));

  const deviceTypes = [{
    id: 'dt_outlet', name: 'OUTLET: DUPLEX', legend_id: 'LEG_OUT',
    detection_config: { anchor: 'N2', anchor_mode: 'exact', families: ['DV', 'DD', 'N'], sources: ['label'] },
  }];

  const { devices, labelInstances } = buildDeviceList(items, deviceTypes, { present: false });
  assert(labelInstances.length === 95, `detector found 95 N2 instances incl. 2 dupes (got ${labelInstances.length})`);
  assert(devices.length === 93, `reconciled to 93 faceplates, dupes collapsed (got ${devices.length})`);
  const coordKeys = devices.map((d) => `${d.x},${d.y}`);
  assert(new Set(coordKeys).size === coordKeys.length, 'no two reconciled faceplates share a coordinate');
  assert(devices.every((d) => d.type === 'OUTLET: DUPLEX'), 'all typed as the outlet device');
  assert(devices.every((d) => routedFt(d) != null), 'distances compute on the reconciled list');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
