// tests/test-wf4-map.mjs — WF4 mapping layer (old floor-plan shapes <-> takeoff rows)
// Run: node tests/test-wf4-map.mjs
import {
  pinKind, demarcBodyToPinRow, pinToDemarc, regionToLegacy,
  manualBodyToInstanceRow, instanceToManual, cullUpdate,
  MANUAL_DEVICE_BASIS, USER_PIN_BASIS,
} from '../netlify/functions/utils/wf4-map.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};
const ctx = { orgId: 7, userId: 'u-1' };

// pin kinds — same rule as the old dedup (exit identified by name suffix)
eq('kind serving', pinKind('user_pin', 'EB51A'), 'serving');
eq('kind exit', pinKind('user_pin', 'TR-4B_exit_pg12'), 'exit');
eq('kind off_sheet', pinKind('off_sheet', 'TR-4B'), 'off_sheet');
eq('kind exit needs digits', pinKind('auto', 'X_exit_pg'), 'serving');

// user pin -> manual row with basis; round-trips back to the demarc shape
const up = demarcBodyToPinRow({ project_id: 3, page_id: 11, name: 'EB51A', source: 'user_pin', x_norm: 0.4, y_norm: 0.6, region_id: 5 }, ctx);
eq('user pin source', [up.source, up.placement, up.override_basis], ['manual', 'manual', USER_PIN_BASIS]);
eq('user pin core', [up.org_id, up.tr_name, up.pin_kind, up.region_id, up.stub_ft], [7, 'EB51A', 'serving', 5, 0]);
const back = pinToDemarc({ ...up, id: 99, entered_at: 't' });
eq('pin -> demarc', [back.id, back.name, back.source, back.region_id, back.x_norm], [99, 'EB51A', 'user_pin', 5, 0.4]);

// region_id omitted -> not written (coords-only update keeps the link)
const coordsOnly = demarcBodyToPinRow({ project_id: 3, page_id: 11, name: 'EB51A_exit_pg11', source: 'user_pin', x_norm: 0.9, y_norm: 0.1 }, ctx);
eq('no region key', 'region_id' in coordsOnly, false);
eq('exit kind', coordsOnly.pin_kind, 'exit');

// auto pin -> extracted, no basis; off-sheet round trip
const auto = demarcBodyToPinRow({ project_id: 3, page_id: 11, name: 'EB51A', source: 'auto', x_norm: 0.5, y_norm: 0.5 }, ctx);
eq('auto pin', [auto.source, auto.placement, auto.override_basis], ['extracted', 'auto_center', null]);
eq('auto -> demarc source', pinToDemarc(auto).source, 'auto');
const off = demarcBodyToPinRow({ project_id: 3, page_id: null, name: 'TR-4B', source: 'off_sheet', stub_ft: 120 }, ctx);
eq('off-sheet row', [off.pin_kind, off.page_id, off.x_norm, off.stub_ft], ['off_sheet', null, null, 120]);
eq('off-sheet -> demarc source', pinToDemarc(off).source, 'off_sheet');

// regions keep the old demarc_id name
eq('region legacy', regionToLegacy({ id: 1, page_id: 2, tr_pin_id: 9, kind: 'exclude' }), { id: 1, page_id: 2, kind: 'exclude', demarc_id: 9 });
eq('region no pin', regionToLegacy({ id: 1, tr_pin_id: null }).demarc_id, null);

// manual device -> device_instances row that satisfies the provenance CHECK
const m = manualBodyToInstanceRow({ project_id: 3, page_id: 11, device_type_id: 4, x_norm: 0.2, y_norm: 0.3, uin: 'A-101' }, ctx);
eq('manual row', [m.source, m.override_basis, m.detection_method, m.uin, m.org_id], ['manual', MANUAL_DEVICE_BASIS, 'manual', 'A-101', 7]);
eq('manual -> legacy', instanceToManual({ ...m, id: 5, entered_at: 't' }), { id: 5, page_id: 11, device_type_id: 4, x_norm: 0.2, y_norm: 0.3, uin: 'A-101', added_at: 't' });

// cull state — excluded mirrors manual_excluded; absent fields untouched
eq('cull on', cullUpdate({ flags: ['ok', 'manual_excluded'], cull_reason: 'dup' }), { flags: ['ok', 'manual_excluded'], excluded: true, cull_reason: 'dup' });
eq('cull clear', cullUpdate({ flags: ['ok'], cull_category: null }), { flags: ['ok'], excluded: false, cull_category: null });
eq('cull reason only', cullUpdate({ cull_reason: 'x' }), { cull_reason: 'x' });
eq('cull nothing', cullUpdate({}), {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
