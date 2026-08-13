// reconcile.test.js — Step 2 gate. Pure fixtures, no PDF. Run: node test/reconcile.test.js
import { reconcile } from '../public/lib/reconcile.js';

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

// ── codes (detail #) carried through merge + leader inheritance ──────────────
console.log('codes + leader flag:');
{
  const catalog = { 'OUTLET: DUPLEX': { sources:['label'], anchor:'N2', anchor_mode:'exact', families:['DV','DD','N'] } };
  const labels = [{ uin:null, type:'OUTLET: DUPLEX', x:0.50, y:0.30, families:['DV','DD','N'], codes:['DV1','DD3','N2'] }];
  const ov = [{ type:'OUTLET: DUPLEX', at:[0.50,0.30], quantity:9 }];
  const out = reconcile(catalog, labels, [], [], {}, ov);
  const grp = out.filter(d => d.type==='OUTLET: DUPLEX');
  const base = grp.find(d => (d.attributes.codes||[]).length);
  assert(base && ['DV1','DD3','N2'].every(c => base.attributes.codes.includes(c)),
    `base carries full codes DV1/DD3/N2 (got ${JSON.stringify(base&&base.attributes.codes)})`);
  assert(grp.length === 9, `leader qty 9 -> 9 devices (got ${grp.length})`);
  assert(grp.every(d => d.flags.includes('leader_expanded')), 'every leader-group member flagged leader_expanded');
  const sib = grp.filter(d => d.sources.length===1 && d.sources[0]==='leader');
  assert(sib.length === 8 && sib.every(d => ['DV1','DD3','N2'].every(c => (d.attributes.codes||[]).includes(c))),
    `8 siblings inherit the base codes (got ${sib.length})`);
}

// ── QTS page 8: FP=12 + ALM=21 label-only reconcile + flag coverage ─────
console.log('QTS page 8 (FP=12 + ALM=21, label UIN reconcile):');
{
  const labelInstances = [];
  for (let k = 1; k <= 12; k++) labelInstances.push({ uin: `FP-${1000 + k}`, type: 'FP', x: (k % 6) / 6, y: (k % 4) / 4 });
  for (let k = 1; k <= 21; k++) labelInstances.push({ uin: `ALM-${2000 + k}`, type: 'ALM', x: (k % 7) / 7, y: 0.5 + (k % 4) / 8 });
  const catalog = { FP: { sources: ['label', 'symbol'] }, ALM: { sources: ['label', 'symbol'] } };
  const devices = reconcile(catalog, labelInstances, [], []);
  const byType = countBy(devices, (d) => d.type);
  assert(byType.FP === 12, `FP count == 12 (got ${byType.FP || 0})`);
  assert(byType.ALM === 21, `ALM count == 21 (got ${byType.ALM || 0})`);
  assert(devices.length === 33, `total devices == 33 (got ${devices.length})`);
  assert(devices.every((d) => d.uin && /-/.test(d.uin)), 'every device carries its full UIN');
  assert(devices.every((d) => d.xy_source === 'label'), 'all placed by label');
}

// ── QTS page 8: schedule-backed with unmatched plate + unscheduled UIN ──
console.log('QTS page 8 (unmatched plate + unscheduled UIN flags):');
{
  const scheduleRows = [], labelInstances = [];
  for (let k = 1; k <= 12; k++) {
    const uin = `FP-${1000 + k}`;
    scheduleRows.push({ uin, type: 'FP', attributes: {} });
    labelInstances.push({ uin, type: 'FP', x: (k % 6) / 6, y: (k % 4) / 4 });
  }
  // unmatched plate: label UIN not in schedule
  labelInstances.push({ uin: 'FP-9999', type: 'FP', x: 0.9, y: 0.9 });
  // unscheduled UIN: schedule row with no label match
  scheduleRows.push({ uin: 'FP-8888', type: 'FP', attributes: {} });
  const catalog = { FP: { sources: ['schedule', 'label', 'symbol'] } };
  const devices = reconcile(catalog, labelInstances, [], scheduleRows);
  assert(devices.length === 14, `14 devices: 12 matched + 1 unmatched plate + 1 unscheduled (got ${devices.length})`);
  const unmatched = devices.filter((d) => d.flags.includes('not_in_schedule'));
  assert(unmatched.length === 1 && unmatched[0].uin === 'FP-9999', 'unmatched plate FP-9999 flagged not_in_schedule');
  const unplaced = devices.filter((d) => d.flags.includes('needs_placement'));
  assert(unplaced.length === 1 && unplaced[0].uin === 'FP-8888', 'unscheduled UIN FP-8888 flagged needs_placement');
  const matched = devices.filter((d) => d.confidence === 'high');
  assert(matched.length === 12, `12 matched devices have confidence high (got ${matched.length})`);
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
