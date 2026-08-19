// test-labor.mjs — offline fixture gate for public/lib/labor.js
// Run: node test-labor.mjs
import { aggregateLaborHours } from './public/lib/labor.js';

let failures = 0;
function check(label, cond) {
  if (!cond) { console.error(`✗ ${label}`); failures++; }
  else console.log(`✓ ${label}`);
}

const typesById = {
  92: { name: '2D TELEDATA OUTLET', labor: {
    '2D': [
      { task_name: 'Terminate + mount faceplate', hrs: 0.114, setup_hrs: 0.25, qty: 2, per_run_ft: false },
      { task_name: 'Pull cable',                   hrs: 0.00375, setup_hrs: 1, per_run_ft: true  },
    ] } },
  95: { name: '4D TELEDATA OUTLET', labor: {} },   // no labor entered yet — must NOT be flagged
};

const instances = [
  { device_type_id: 92, raw_labels: ['2D'], removed_by_user: false, total_ft: 120 },
  { device_type_id: 92, raw_labels: ['2D'], removed_by_user: false, total_ft: 80 },
  { device_type_id: 92, raw_labels: ['2D'], removed_by_user: false, total_ft: null },   // can't scale pull-cable task
  { device_type_id: 95, raw_labels: ['4D'], removed_by_user: false, total_ft: 50 },     // no labor -> silently skipped, not flagged
];

const result = aggregateLaborHours(instances, typesById);

check('2 task lines aggregated (terminate, pull cable)', result.tasks.length === 2);

const term = result.tasks.find(t => t.task_name === 'Terminate + mount faceplate');
// flat task w/ qty=2 (2 ports per outlet): (0.114*2 + 0.25 setup) * 3 instances = 1.434
check('flat task w/ qty=2 hours = (0.114*2+0.25)*3 = 1.434', term.hours === 1.434);

const pull = result.tasks.find(t => t.task_name === 'Pull cable');
// per_run_ft: only 2 of 3 instances have distance -> (120*0.00375+1) + (80*0.00375+1) = 1.45 + 1.3 = 2.75
check('per_run_ft task hours = 1.45 + 1.3 = 2.75 (3rd instance skipped, no distance)', pull.hours === 2.75);

check('missing_distance flags the 3rd instance for Pull cable\'s kind', 
  result.missing_distance.length === 1 && result.missing_distance[0].instances === 1 && result.missing_distance[0].family === '2D');

check('device type 95 (empty labor) produces NO flag at all', 
  !result.missing_distance.some(f => f.type_id === 95));

check('total_hours = 1.434 + 2.75 = 4.184', result.total_hours === 4.184);

check('coverage.total_instances = 4', result.coverage.total_instances === 4);
check('coverage.expanded_instances = 3 (device 95 has no labor, contributes 0 lines)', result.coverage.expanded_instances === 3);

// ── Mutation test: prove a broken version that fabricates 0-ft hours instead of flagging gets caught.
function aggregateLaborHours_broken(instancesIn, typesByIdIn) {
  let total_hours = 0;
  for (const inst of instancesIn) {
    const type = typesByIdIn[inst.device_type_id] || {};
    for (const kind in (type.labor || {})) {
      for (const t of type.labor[kind]) {
        const ft = Number(inst.total_ft) || 0;   // BUG: defaults missing distance to 0 instead of skipping
        total_hours += t.per_run_ft ? (t.hrs * ft + (t.setup_hrs||0)) : (t.hrs + (t.setup_hrs||0));
      }
    }
  }
  return total_hours;
}
const brokenTotal = aggregateLaborHours_broken(instances, typesById);
check('mutation test: broken version silently fabricates hours for the no-distance instance (proves the gate distinguishes correct behavior)',
  brokenTotal !== result.total_hours);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
