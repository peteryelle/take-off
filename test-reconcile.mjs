// reconcile.test.js — Step 2 gate. Pure fixtures, no PDF. Run: node test/reconcile.test.js
import { reconcile } from './public/lib/reconcile.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) { console.log('  PASS ', msg); }
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});

// ----------------------------------------------------------------------------
// QTS fixture: a schedule-backed security site. The proven offline run on the
// real plan collapsed 124 raw prefix tokens (45 of them bare, no UIN) down to
// 40 UIN'd devices: CAM 11, VIC 10, CR 7, ACP 4, DC 3, KB 2, ALM 2, AD 1.
// Here we reproduce the reconcile half: 40 schedule rows + the same 40 UINs
// echoed as plan labels (the double-count) must fold to 40, not 80.
// ----------------------------------------------------------------------------
function qtsFixture() {
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const scheduleRows = [], labelInstances = [];
  let i = 0;
  for (const [type, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      const uin = `${type}-EXT-${k}`;
      scheduleRows.push({ uin, type, attributes: { cable_dest: [`EXTIDF${(i % 6) + 1}`] } });
      // same UIN appears again as a plan callout label, with a position
      labelInstances.push({ uin, type, x: 0.1 + (i % 9) * 0.1, y: 0.1 + ((i * 7) % 8) * 0.1 });
      i++;
    }
  }
  // a couple of accidental exact-duplicate label rows for the same UIN (must NOT add devices)
  labelInstances.push({ uin: 'CAM-EXT-1', type: 'CAM', x: 0.1, y: 0.1 });
  labelInstances.push({ uin: 'VIC-EXT-1', type: 'VIC', x: 0.2, y: 0.3 });
  const catalog = Object.fromEntries(Object.keys(spec).map((t) => [t, { sources: ['schedule', 'label', 'symbol'] }]));
  return { catalog, labelInstances, symbolInstances: [], scheduleRows };
}

// ----------------------------------------------------------------------------
// VA fixture: label-only (no schedule). Outlets keyed on the once-per-plate N2
// anchor. The over-split / two-gang artifacts land as duplicate instances at an
// IDENTICAL coordinate (e.g. the proven 0.477,0.515 pair). reconcile must fold
// each duplicate pair into one faceplate. Here: 7 instances -> 5 faceplates.
// ----------------------------------------------------------------------------
function vaFixture() {
  const f = ['DV', 'DD', 'N'];
  const labelInstances = [
    { type: 'outlet', x: 0.477, y: 0.515, codes: ['DV1', 'DD2', 'N2'] }, // A   (proven dup coord)
    { type: 'outlet', x: 0.477, y: 0.515, codes: ['DD3', 'N2'] },        // A'  duplicate of A -> folds
    { type: 'outlet', x: 0.200, y: 0.300, families: f },                 // B
    { type: 'outlet', x: 0.200, y: 0.300, families: ['DD', 'N'] },       // B'  duplicate of B -> folds
    { type: 'outlet', x: 0.600, y: 0.400, families: f },                 // C
    { type: 'outlet', x: 0.700, y: 0.550, families: f },                 // D
    { type: 'outlet', x: 0.355, y: 0.620, families: f },                 // E
  ];
  const catalog = { outlet: { sources: ['label'] } }; // label-only: no schedule, seed from labels
  return { catalog, labelInstances, symbolInstances: [], scheduleRows: [] };
}

// ---- QTS gate -------------------------------------------------------------
console.log('QTS fixture (schedule + label, UIN join):');
{
  const { catalog, labelInstances, symbolInstances, scheduleRows } = qtsFixture();
  const devices = reconcile(catalog, labelInstances, symbolInstances, scheduleRows);
  assert(devices.length === 40, `reconciled device count == 40 (got ${devices.length})`);
  const byType = countBy(devices, (d) => d.type);
  const expected = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  assert(JSON.stringify(byType) === JSON.stringify(expected), `by-type split matches ${JSON.stringify(expected)} (got ${JSON.stringify(byType)})`);
  const allHigh = devices.every((d) => d.confidence === 'high' && new Set(d.sources).size >= 2);
  assert(allHigh, 'every device has >=2 sources (schedule+label) and confidence "high"');
  assert(devices.every((d) => d.uin), 'every reconciled device carries its UIN');
  assert(devices.every((d) => Array.isArray(d.attributes.cable_dest)), 'cable_dest carried through from schedule attributes');
}

// ---- VA gate --------------------------------------------------------------
console.log('VA fixture (label-only, exact-coordinate dedup):');
{
  const { catalog, labelInstances, symbolInstances, scheduleRows } = vaFixture();
  const devices = reconcile(catalog, labelInstances, symbolInstances, scheduleRows);
  assert(devices.length === 5, `7 instances collapse to 5 faceplates (got ${devices.length})`);
  // no two output devices share an identical (type,x,y) -> duplicate pairs gone
  const coords = devices.map((d) => `${d.type}@${d.x},${d.y}`);
  assert(new Set(coords).size === coords.length, 'no two reconciled faceplates share a coordinate');
  // the proven duplicate coordinate survives exactly once, with families unioned
  const a = devices.filter((d) => d.x === 0.477 && d.y === 0.515);
  assert(a.length === 1, 'the 0.477,0.515 duplicate pair folded to a single faceplate');
  assert(a[0] && new Set(a[0].attributes.families).size === 3 &&
    ['DV', 'DD', 'N'].every((f) => a[0].attributes.families.includes(f)),
    'folded faceplate unions families DV+DD+N from both rows');
  assert(devices.every((d) => d.uin === null), 'label-only faceplates have uin=null (no schedule/UIN)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
