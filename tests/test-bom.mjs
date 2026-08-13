// test-bom.mjs — regression gate for public/lib/bom.js
// Fixtured on Demo 1 (project 6): 19 camera, 59 WAP, 109 PORT.
// Run from repo root:  node test-bom.mjs
import { labelKind, deviceKinds, expandInstance, aggregateBom } from '../public/lib/bom.js';

let fails = 0;
const eq = (got, want, msg) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL ${msg}\n  got  ${a}\n  want ${b}`); fails++; }
  else console.log(`ok   ${msg}`);
};

// ── labelKind: family cut reproduces the authored assembly keys ──
eq(labelKind('DV1'), 'DV',  'labelKind DV1->DV');
eq(labelKind('N2'),  'N',   'labelKind N2->N');
eq(labelKind('WAP'), 'WAP', 'labelKind WAP->WAP');
eq(labelKind('180'), '180', 'labelKind 180->180 (digits-only keeps token)');
eq(deviceKinds(['DV1','DD2','N2','DV2']), ['DV','DD','N'], 'deviceKinds dedups families, preserves order');

// ── live assemblies (verbatim from device_types 72/73/74) ──
const types = {
  72: { name: 'SECURITY ACCESS, VIDEO CAMERA WITH LENS', assembly: {
        '180': [
          { qty: 1, model: '6ftjumper', part_name: 'jumper', device_name: '6ft cat6 jumper', manufacturer: 'CableCo' },
          { qty: 1, model: 'box',       part_name: 'box',    device_name: 'camera enclosure', manufacturer: 'BoxCo' },
        ] } },
  73: { name: 'WAP', assembly: {
        'WAP': [
          { qty: 1, model: 'WAPJ6',  part_name: 'WAPJumper', device_name: '6ft cat6 jumper', manufacturer: 'CableCo' },
          { qty: 1, model: 'BOXWAP', part_name: 'WAPBox',    device_name: 'WAP box',         manufacturer: 'BoxCo' },
        ] } },
  74: { name: 'PORT', assembly: {
        'DV': [
          { qty: 1, model: 'PBox', part_name: 'PortBox', device_name: 'Box', manufacturer: 'Boxco' },
        ] } },  // DD and N families intentionally unmodeled
};

// ── rebuild the real instance distribution for project 6 ──
const mk = (type_id, raw_labels, n) =>
  Array.from({ length: n }, () => ({ device_type_id: type_id, raw_labels, removed_by_user: false }));

const instances = [
  ...mk(72, ['180'], 19),
  ...mk(73, ['WAP'], 59),
  ...mk(74, ['DV1','DD2','N2'], 39),
  ...mk(74, ['DV1','N2','DD2'], 30),
  ...mk(74, ['DV1','N2'], 19),
  ...mk(74, ['DV1','N2','DD2','DV2'], 4),
  ...mk(74, ['DV1','DD3','N2'], 4),
  ...mk(74, ['DV1','N2','DD3'], 3),
  ...mk(74, ['DV1','N2','DD1'], 2),
  ...mk(74, ['DV1','N2','DV2'], 1),
  ...mk(74, ['DV1','DD1'], 1),
  ...mk(74, ['DV1','DD2'], 1),
  ...mk(74, ['DV1','DD2','DV2','N2','N*3'], 1),
  ...mk(74, ['DV1','DD2','N2','DV2'], 1),
  ...mk(74, ['DV1','DD3','N2','DD2'], 1),
  ...mk(74, ['DV1','DV2','DD2','N2','N3'], 1),
  ...mk(74, ['DV1','N2','DD3','DD2'], 1),
];
eq(instances.length, 187, 'instance fixture totals 187');

// ── single-instance expansion: one expansion per modeled family ──
const port = expandInstance({ device_type_id: 74, raw_labels: ['DV1','DV2','DD2','N2'] }, types[74].assembly);
eq(port.lines.map(l => l.part_name), ['PortBox'], 'DV1+DV2 expands DV ONCE, not per label');
eq(port.unmodeled.sort(), ['DD','N'], 'DD and N flagged as unmodeled');

// ── project aggregate ──
const bom = aggregateBom(instances, types);
const q = (mfr, part) => {
  const row = bom.components.find(c => c.manufacturer === mfr && c.part_name === part);
  return row ? row.qty : undefined;
};
eq(q('CableCo','jumper'),    19,  'camera jumper = 19');
eq(q('BoxCo','box'),         19,  'camera enclosure = 19');
eq(q('CableCo','WAPJumper'), 59,  'WAP jumper = 59');
eq(q('BoxCo','WAPBox'),      59,  'WAP box = 59');
eq(q('Boxco','PortBox'),     109, 'PORT box = 109 (every outlet carries DV)');

const dd = bom.unmodeled.find(u => u.family === 'DD');
const n  = bom.unmodeled.find(u => u.family === 'N');
eq(dd && dd.instances, 89,  'unmodeled DD on 89 outlets');
eq(n  && n.instances,  107, 'unmodeled N on 107 outlets');
eq(bom.coverage, { total_instances: 187, expanded_instances: 187, flagged_instances: 109 },
   'coverage: all 187 expand something, 109 carry an unmodeled family');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
