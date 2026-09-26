// tests/test-wf4-rollup.mjs — WF4 Review roll-up
// Run: node tests/test-wf4-rollup.mjs
import { rollup, countablePageIds } from '../public/lib/wf4-rollup.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

const pages = [
  { id: 1, role: 'plan', level: 'L1', page_number: 3, title_text: 'T-101' },
  { id: 2, role: 'plan', level: 'L2', page_number: 4, title_text: 'T-102' },
  { id: 3, role: 'legend', page_number: 1 },
  { id: 4, role: 'plan', level: 'L2', page_number: 5, is_duplicate: true },
];
const types = [{ id: 10, name: 'DD2' }, { id: 11, name: 'WAP' }];
const devices = [
  { id: 100, page_id: 1, device_type_id: 10, tr_name: 'EB51A', route_ft: 80.5, route_method: 'straight', route_multiplier: 1.35 },
  { id: 101, page_id: 1, device_type_id: 10, tr_name: 'EB51A', route_ft: 120, route_method: 'straight', route_multiplier: 1.35, tia_flag: false },
  { id: 102, page_id: 1, device_type_id: 11, tr_name: 'EB51A', route_ft: null, route_method: 'none', flags: ['needs_placement'] },
  { id: 103, page_id: 2, device_type_id: 10, tr_name: 'EB52B', route_ft: 310, route_method: 'routed', route_multiplier: 1.1, tia_flag: true },
  { id: 104, page_id: 2, device_type_id: 11, tr_name: 'EB52B', route_ft: 40, route_method: 'straight', route_multiplier: 1.35, excluded: true },
  { id: 105, page_id: 2, device_type_id: 11, tr_name: 'EB52B', route_ft: 55, route_method: 'straight', route_multiplier: 1.35, source: 'manual' },
  { id: 106, page_id: 3, device_type_id: 10, route_ft: 999 },   // legend page — never counted
  { id: 107, page_id: 4, device_type_id: 10, route_ft: 999 },   // duplicate page — never counted
];

const r = rollup(devices, pages, types);
eq('countable pages', [...countablePageIds(pages)], ['1', '2']);
eq('totals', r.totals, { devices: 5, cable_ft: 565.5, no_length: 1, excluded: 1, tia: 1, manual: 1, needs_placement: 1 });
eq('by level', r.by_level, [
  { level: 'L1', devices: 3, by_type: { DD2: 2, WAP: 1 } },
  { level: 'L2', devices: 2, by_type: { DD2: 1, WAP: 1 } },
]);
eq('by TR', r.by_tr.map((t) => [t.tr_name, t.devices, t.cable_ft, t.no_length]), [['EB51A', 3, 200.5, 1], ['EB52B', 2, 365, 0]]);
eq('routing used', r.routing_used, [{ mode: 'straight', multiplier: 1.35, devices: 3 }, { mode: 'routed', multiplier: 1.1, devices: 1 }]);
eq('tia list', r.tia_violations.map((t) => t.id), [103]);
eq('excluded ids', r.excluded_ids, [104]);
eq('per page', r.per_page.map((p) => [p.page_number, p.devices, p.excluded, p.no_length, p.tia, p.manual]), [[3, 3, 0, 1, 0, 0], [4, 2, 1, 0, 1, 1]]);
eq('skipped pages', r.skipped_pages, 2);
eq('device level wins over page level', rollup([{ id: 1, page_id: 1, device_type_id: 10, level: 'L1-East', route_ft: 1 }], pages, types).by_level[0].level, 'L1-East');
eq('empty', rollup([], [], []).totals, { devices: 0, cable_ft: 0, no_length: 0, excluded: 0, tia: 0, manual: 0, needs_placement: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
