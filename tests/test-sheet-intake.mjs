// Gate: sheet intake — nothing silently replaces anything.
import { classifyIncoming, stepForRole } from '../public/lib/sheet-intake.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const T15K = { sheet_id: 7, revisions: [{ id: 70, rev_label: 'Rev.0', content_hash: 'aaa', status: 'accepted' }] };

let r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: 'Rev.0', content_hash: 'aaa' }, null, 'd1');
ok(r.kind === 'new_sheet' && r.rev_label === 'Rev.0' && r.status === 'accepted' && !r.rev_assumed, 'first sighting -> new sheet, accepted');

r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: null, content_hash: 'aaa' }, null, 'd1');
ok(r.kind === 'new_sheet' && r.rev_label === 'Rev.0' && r.rev_assumed, 'no revision printed -> Rev.0 marked assumed');

r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: null, content_hash: 'aaa' }, T15K, 'd2');
ok(r.kind === 'duplicate' && r.of_revision_id === 70, 'same content in master PDF and zone file -> duplicate, counted once');

r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: 'Rev.1', content_hash: 'bbb' }, T15K, 'd3');
ok(r.kind === 'new_revision' && r.status === 'pending' && r.rev_label === 'Rev.1', 'reissue -> new revision, PENDING until accepted');

r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: 'Rev.0', content_hash: 'ccc' }, T15K, 'd4');
ok(r.kind === 'conflict' && r.status === 'pending' && r.rev_label.includes('alt d4'), 'same sheet+rev, different content -> conflict for the user');

r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: null, content_hash: 'ddd' }, T15K, 'd5');
ok(r.kind === 'new_revision' && r.rev_assumed && r.status === 'pending', 'changed page with no revision number -> pending, flagged');

r = classifyIncoming({ sheet_number: null, rev_label: null, content_hash: 'eee' }, null, 'd6');
ok(r.kind === 'unnumbered', 'no sheet number -> unnumbered, user assigns');

const rejected = { sheet_id: 7, revisions: [{ id: 71, rev_label: 'Rev.1', content_hash: 'bbb', status: 'rejected' }] };
r = classifyIncoming({ sheet_number: 'T1.5.K', rev_label: 'Rev.2', content_hash: 'bbb' }, rejected, 'd7');
ok(r.kind === 'new_revision', 'a previously rejected revision is not treated as a duplicate');

ok(stepForRole('plan') === 'WF4' && stepForRole('key_plan') === 'WF4', 'plan roles -> WF4');
ok(stepForRole('osp_route') === 'WF3' && stepForRole('riser') === 'WF7' && stepForRole('notes') === 'WF1', 'role -> step mapping');
ok(stepForRole('skip') === null && stepForRole(null) === null, 'skip / no role -> no step');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
