// test-bom-cable-run.mjs — regression gate for per_run_ft (cable-to-TR)
// scaling in public/lib/bom.js.
//
// Run from repo root:  node test-bom-cable-run.mjs
import { expandInstance, aggregateBom } from './public/lib/bom.js';

let fails = 0;
const eq = (got, want, msg) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL ${msg}\n  got  ${a}\n  want ${b}`); fails++; }
  else console.log(`ok   ${msg}`);
};

// device type: outlet with a fixed jack + faceplate, plus a home-run cable
// scaled by the instance's routed distance back to its TR. qty=1.05 models
// a 5% waste allowance on the cable.
const assembly = {
  '2D': [
    { qty: 1,    part_name: 'jack',     manufacturer: 'ports-r-us',  device_name: 'port' },
    { qty: 1,    part_name: 'plate',    manufacturer: 'plates-r-us', device_name: 'faceplate' },
    { qty: 1.05, part_name: 'cat6a',    manufacturer: 'cables-r-us', device_name: 'home run', per_run_ft: true },
  ],
};
const type = { name: '2D TELEDATA OUTLET', assembly };

// ── expandInstance: a single instance with a real distance ──
const withDist = expandInstance({ raw_labels: ['2D'], total_ft: 120 }, assembly);
eq(withDist.lines.find(l => l.part_name === 'jack').qty,  1,   'jack stays fixed qty=1 regardless of distance');
eq(withDist.lines.find(l => l.part_name === 'cat6a').qty, 126, 'cable = 120ft * 1.05 waste = 126');
eq(withDist.missingDistance, [], 'no missing-distance flag when total_ft is present');

// ── expandInstance: a counted instance with NO distance yet (not yet demarc-assigned) ──
const noDist = expandInstance({ raw_labels: ['2D'], total_ft: null }, assembly);
eq(noDist.lines.map(l => l.part_name), ['jack', 'plate'],
   'fixed-qty lines still expand even without a distance');
eq(noDist.missingDistance, ['2D'], 'per_run_ft family flagged as missing_distance, not fabricated as 0ft');

// ── aggregateBom: mixed project — some instances have distance, one doesn't ──
const instances = [
  { device_type_id: 1, raw_labels: ['2D'], total_ft: 100 },
  { device_type_id: 1, raw_labels: ['2D'], total_ft: 50 },
  { device_type_id: 1, raw_labels: ['2D'], total_ft: null },   // no demarc assigned yet
];
const bom = aggregateBom(instances, { 1: type });
const cable = bom.components.find(c => c.part_name === 'cat6a');
eq(cable.qty, Math.round((100 * 1.05 + 50 * 1.05) * 10) / 10,
   'project cable total sums only the two instances with a real distance (157.5)');

const jack = bom.components.find(c => c.part_name === 'jack');
eq(jack.qty, 3, 'jack still counts all 3 instances — fixed-qty lines are unaffected by missing distance');

eq(bom.missing_distance, [{ type_id: 1, name: '2D TELEDATA OUTLET', family: '2D', instances: 1 }],
   'one instance surfaces in missing_distance, keyed by type+family like unmodeled');
eq(bom.coverage.flagged_instances, 1,
   'coverage.flagged_instances counts missing_distance flags same as unmodeled ones');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
