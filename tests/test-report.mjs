// test-report.mjs — regression gate for report.html's data-shaping logic.
// Fixtured on device_type 92 (project 12, "2D TELEDATA OUTLET"), the real
// assembly saved and verified in this conversation.
//
// Two things this locks down, since both were live bugs when this page
// was built:
//   1. Culling is signaled by flags containing 'manual_excluded', NOT by
//      device_instances.removed_by_user (which is never written anywhere
//      in the live cull path — see submitCull in multi-page.html). The
//      report must translate flags -> removed_by_user before calling
//      aggregateBom(), or culled devices silently stay in the BOM.
//   2. typesById must be keyed by the numeric device_types.id (the real
//      FK on device_instances.device_type_id), not by legend_id/name —
//      that string-keying is a multi-page.html/batchResults-only quirk
//      that does not apply when reading device_instances directly.
//
// Run from repo root:  node test-report.mjs
import { aggregateBom } from '../public/lib/bom.js';

let fails = 0;
const eq = (got, want, msg) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL ${msg}\n  got  ${a}\n  want ${b}`); fails++; }
  else console.log(`ok   ${msg}`);
};

// ── real saved assembly, device_type 92 ──
const deviceTypes = [
  { id: 92, name: '2D TELEDATA OUTLET', assembly: {
      '2D': [
        { qty: 1, model: 'abc-def', part_name: 'cat6afe',  device_name: 'port',        manufacturer: 'ports-r-us'  },
        { qty: 1, model: 'plate',   part_name: 'plate-001', device_name: 'faceplate',   manufacturer: 'plates-r-us' },
        { qty: 1, model: 'cables',  part_name: 'pig6a',     device_name: 'cat6A pigtail', manufacturer: 'cables-r-us' },
      ] } },
];

// ── simulated device_instances rows, shaped exactly like takeoff-summary.js returns them ──
const rawInstances = [
  { device_type_id: 92, raw_labels: ['2D'], flags: null,                     tia_flag: false },
  { device_type_id: 92, raw_labels: ['2D'], flags: [],                       tia_flag: false },
  { device_type_id: 92, raw_labels: ['2D'], flags: ['manual_excluded'],      tia_flag: false }, // culled -> junk
  { device_type_id: 92, raw_labels: ['2D'], flags: ['no_uin','manual_excluded'], tia_flag: false }, // culled -> excluded, other flags present too
  { device_type_id: 92, raw_labels: ['2D'], flags: ['no_uin'],               tia_flag: true  },
];

// ── report.html's exact translation logic ──
function isCulled(inst) {
  return Array.isArray(inst.flags) && inst.flags.includes('manual_excluded');
}
const typesById = {};
for (const dt of deviceTypes) typesById[dt.id] = { name: dt.name, assembly: dt.assembly };

const instances = rawInstances.map(inst => ({
  device_type_id:  inst.device_type_id,
  raw_labels:      inst.raw_labels ?? [],
  removed_by_user: isCulled(inst),
}));

eq(instances.filter(i => i.removed_by_user).length, 2, '2 of 5 instances detected as culled via flags');

const activeInstances = rawInstances.filter(i => !isCulled(i));
eq(activeInstances.length, 3, '3 active (non-culled) instances remain');
eq(activeInstances.filter(i => i.tia_flag).length, 1, '1 active instance carries a TIA flag');

const bom = aggregateBom(instances, typesById);
const q = (mfr, part) => bom.components.find(c => c.manufacturer === mfr && c.part_name === part)?.qty;

eq(q('ports-r-us','cat6afe'),   3, 'jack qty = 3 (culled instances excluded, not 5)');
eq(q('plates-r-us','plate-001'), 3, 'faceplate qty = 3');
eq(q('cables-r-us','pig6a'),     3, 'pigtail qty = 3');
// Note: aggregateBom() skips removed_by_user rows BEFORE incrementing total_instances,
// so coverage.total_instances is already "active only" — not a raw row count. The
// report's own culledCount stat (rawInstances.length - activeInstances.length) is
// computed independently, from the pre-filter array, for exactly this reason.
eq(bom.coverage, { total_instances: 3, expanded_instances: 3, flagged_instances: 0 },
   'coverage: culled rows excluded before total_instances is even counted');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
