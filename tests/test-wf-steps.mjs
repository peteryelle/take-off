// Gate: v2 workflow step logic — recommended order, never a lock.
import {
  STEP_CODES, initialStepRows, missingUpstream, bomReady, nextUp, stepSummary,
} from '../public/lib/wf-steps.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const rows = (m) => STEP_CODES.map((c) => ({ step_code: c, status: m[c] || 'open', stale_reason: null }));

// initialStepRows
const all = initialStepRows();
ok(all.length === 8 && all.every((r) => r.status === 'open'), 'no scope given -> all 8 steps open');
const plansOnly = initialStepRows(['WF4']);
ok(plansOnly.find((r) => r.step_code === 'WF4').status === 'open', 'floor-plan-only job: WF4 open');
ok(plansOnly.find((r) => r.step_code === 'WF8').status === 'open', 'WF8 always in scope');
ok(plansOnly.filter((r) => r.status === 'not_applicable').length === 6, 'the other 6 steps start N/A');

// missingUpstream: soft dependencies
ok(missingUpstream('WF4', rows({})).map((m) => m.needs).join() === 'WF1,WF2', 'WF4 alone reports WF1 and WF2 as missing');
ok(missingUpstream('WF4', rows({ WF1: 'confirmed', WF2: 'confirmed' })).length === 0, 'nothing missing once upstream confirmed');
ok(missingUpstream('WF4', rows({ WF1: 'not_applicable', WF2: 'not_applicable' })).length === 0, 'N/A upstream is not "missing"');
ok(missingUpstream('WF2', rows({})).length === 0, 'WF2 has no upstream');

// bomReady
ok(!bomReady(rows({})), 'BOM not ready with open steps');
const plansDone = initialStepRows(['WF4']).map((r) => (r.step_code === 'WF4' ? { ...r, status: 'confirmed' } : r));
ok(bomReady(plansDone), 'floor-plan-only job: BOM ready once WF4 confirmed');
ok(!bomReady(rows({ WF1: 'confirmed', WF2: 'confirmed', WF3: 'confirmed', WF4: 'stale', WF5: 'confirmed', WF6: 'confirmed', WF7: 'confirmed' })), 'a stale step blocks BOM');

// nextUp
ok(nextUp(rows({})).code === 'WF1', 'fresh project -> next up is WF1');
const stale = rows({ WF1: 'confirmed', WF4: 'stale' }).map((r) => (r.step_code === 'WF4' ? { ...r, stale_reason: 'T1.3.D Rev.2' } : r));
const n = nextUp(stale);
ok(n.code === 'WF4' && n.kind === 'stale' && n.text.includes('T1.3.D Rev.2'), 'stale step outranks unfinished steps');
ok(nextUp(plansDone).kind === 'bom', 'everything confirmed -> next up is the BOM');

// stepSummary
ok(stepSummary('WF4', rows({})).note.startsWith('works now;'), 'WF4 summary says it works now, with what is degraded');
ok(stepSummary('WF3', initialStepRows(['WF4'])).label === 'N/A', 'N/A step labelled N/A');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
