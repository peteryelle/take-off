// test-reconcile-echo.mjs — schedule-echo suppression gate (the QTS SE02-01AB bug).
//
// The break: ALM/FP are scheduled, and each UIN appears in the text layer TWICE —
// once as the plan stamp and once as the detail-schedule row (X locked ~0.746).
// detect.js emits both; reconcile's last-write-wins parked the device on the table
// (outside the distance boxes → out_of_scope → no-dist; or, when the table band fell
// inside a box, a wrong non-null distance). With the schedule row's own xy supplied,
// reconcile drops the echo and keeps the plan stamp.
//
// Pure, no PDF. Run: node test-reconcile-echo.mjs
import { reconcile } from '../public/lib/reconcile.js';

let failures = 0;
const assert = (cond, msg) => { if (cond) console.log('  PASS ', msg); else { console.log('  FAIL ', msg); failures++; } };
const get = (devs, uin) => devs.find((d) => d.uin === uin);
const inBoxList = (boxes, x, y) => x != null && boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);

const SCHED_X = 0.746;   // the schedule table's UIN column (the off-plan parking spot)
const catalog = { ALM: { sources: ['schedule', 'label', 'symbol'] } };

console.log('Echo suppression — plan stamp wins, echo-only falls to needs_placement:');
{
  // Schedule rows carry their own UIN-text xy (host-supplied).
  const scheduleRows = [
    { uin: 'ALM-0134',  type: 'ALM', x: SCHED_X, y: 0.121, attributes: { cable_dest: ['SDF0134'] } },
    { uin: 'ALM-0150E', type: 'ALM', x: SCHED_X, y: 0.188, attributes: { cable_dest: ['SDF0134'] } },
    { uin: 'ALM-EONLY', type: 'ALM', x: SCHED_X, y: 0.200, attributes: { cable_dest: ['SDF0134'] } },
  ];
  // Text layer: every scheduled UIN echoed at the table position; two also stamped on
  // the plan; one (EONLY) has no plan stamp; ALM-1100B is on the plan but not scheduled.
  const labelInstances = [
    { uin: 'ALM-0134',  type: 'ALM', x: SCHED_X, y: 0.121 },   // echo  -> dropped
    { uin: 'ALM-0134',  type: 'ALM', x: 0.300,   y: 0.400 },   // stamp -> placed
    { uin: 'ALM-0150E', type: 'ALM', x: SCHED_X, y: 0.188 },   // echo  -> dropped
    { uin: 'ALM-0150E', type: 'ALM', x: 0.320,   y: 0.640 },   // stamp -> placed
    { uin: 'ALM-EONLY', type: 'ALM', x: SCHED_X, y: 0.200 },   // echo only -> unplaced
    { uin: 'ALM-1100B', type: 'ALM', x: 0.712,   y: 0.671 },   // not in schedule
  ];

  const devices = reconcile(catalog, labelInstances, [], scheduleRows);

  assert(devices.length === 4, `4 devices: 3 scheduled + ALM-1100B (got ${devices.length})`);

  const a134 = get(devices, 'ALM-0134');
  assert(a134 && a134.x === 0.300 && a134.y === 0.400,
    `ALM-0134 lands on the plan stamp 0.300,0.400 (got ${a134 && a134.x},${a134 && a134.y})`);
  assert(a134 && a134.xy_source === 'label' && a134.sources.includes('schedule') && a134.sources.includes('label') && a134.confidence === 'high',
    'ALM-0134 schedule+label, high — the echo never inflated agreement');

  const a150 = get(devices, 'ALM-0150E');
  assert(a150 && a150.x === 0.320 && a150.y === 0.640, `ALM-0150E lands on its plan stamp (got ${a150 && a150.x},${a150 && a150.y})`);

  const eonly = get(devices, 'ALM-EONLY');
  assert(eonly && eonly.x == null && eonly.flags.includes('needs_placement'),
    'echo-only ALM-EONLY stays unplaced -> needs_placement (not parked on the table)');
  assert(eonly && eonly.sources.length === 1 && eonly.sources[0] === 'schedule' && eonly.confidence === 'medium',
    'echo-only device is schedule-only, medium — the echo added no false label source');

  const stray = get(devices, 'ALM-1100B');
  assert(stray && stray.flags.includes('not_in_schedule') && stray.x === 0.712,
    'ALM-1100B (plan, unscheduled) still placed + flagged not_in_schedule');

  const placed = devices.filter((d) => d.x != null);
  assert(placed.every((d) => d.x !== SCHED_X), 'no placed device sits on the schedule column — off-plan parking is gone');
  assert(devices.every((d) => !d.attributes || !('_sched_xy' in d.attributes)), 'internal _sched_xy hint is not surfaced');
}

console.log('Back-compat — rows WITHOUT xy behave exactly as before (suppression inert):');
{
  // No schedule xy supplied -> reconcile cannot tell echo from stamp, so the label
  // places the device as it always did. This is the VA / pre-fix path; it must not change.
  const scheduleRows = [{ uin: 'ALM-7001', type: 'ALM', attributes: {} }];
  const labelInstances = [{ uin: 'ALM-7001', type: 'ALM', x: SCHED_X, y: 0.300 }];
  const devices = reconcile(catalog, labelInstances, [], scheduleRows);
  const d = get(devices, 'ALM-7001');
  assert(d && d.x === SCHED_X && d.y === 0.300 && d.sources.includes('label') && d.confidence === 'high',
    'no-xy schedule row -> label places normally (full back-compat)');
}

console.log('Multi-plan / multi-schedule — per-plan boxes carry it (region beats parse coverage):');
{
  // Two plans on one page, each boxed, each with its own schedule table. Segment A's
  // schedule parsed (rows carry _sched_xy); Segment B's did NOT (side-by-side table the
  // single-table parser missed) -> ALM-B has NO schedule xy. The boxes alone must still
  // keep both devices on their stamps and both echoes off.
  const boxA = { x0: 0.05, y0: 0.30, x1: 0.45, y1: 0.95 };  // left plan
  const boxB = { x0: 0.50, y0: 0.30, x1: 0.95, y1: 0.95 };  // right plan
  const scheduleRows = [
    { uin: 'ALM-A', type: 'ALM', x: SCHED_X, y: 0.121, attributes: {} },  // parsed -> has xy
    { uin: 'ALM-B', type: 'ALM',                       attributes: {} },  // 2nd table unparsed -> NO xy
  ];
  const labelInstances = [
    { uin: 'ALM-A', type: 'ALM', x: SCHED_X, y: 0.121 },  // echo (outside both boxes)
    { uin: 'ALM-A', type: 'ALM', x: 0.20,    y: 0.60 },   // stamp in box A
    { uin: 'ALM-B', type: 'ALM', x: 0.748,   y: 0.105 },  // echo (outside both boxes), no _sched_xy to catch it
    { uin: 'ALM-B', type: 'ALM', x: 0.70,    y: 0.62 },   // stamp in box B
  ];
  const devices = reconcile(catalog, labelInstances, [], scheduleRows, { planRegions: [boxA, boxB] });

  const a = get(devices, 'ALM-A'), b = get(devices, 'ALM-B');
  assert(a && a.x === 0.20 && a.y === 0.60, `ALM-A lands in box A stamp (got ${a && a.x},${a && a.y})`);
  assert(b && b.x === 0.70 && b.y === 0.62, `ALM-B lands in box B stamp via region alone, no schedule xy (got ${b && b.x},${b && b.y})`);
  assert(devices.every((d) => inBoxList([boxA, boxB], d.x, d.y) || d.x == null),
    'every placed device sits inside a plan box — both echoes dropped');
}

console.log('Rule 3 — scheduled device on an UN-boxed plan still places on its stamp, never stranded:');
{
  const boxA = { x0: 0.05, y0: 0.30, x1: 0.45, y1: 0.95 };   // only plan A is boxed
  const scheduleRows = [
    { uin: 'ALM-U', type: 'ALM', x: SCHED_X, y: 0.150, attributes: {} },  // its plan (B) was not boxed
    { uin: 'ALM-V', type: 'ALM', x: SCHED_X, y: 0.160, attributes: {} },  // echo-only, no stamp anywhere
  ];
  const labelInstances = [
    { uin: 'ALM-U', type: 'ALM', x: SCHED_X, y: 0.150 },  // echo
    { uin: 'ALM-U', type: 'ALM', x: 0.70,    y: 0.62 },   // real stamp, but in the un-boxed plan B
    { uin: 'ALM-V', type: 'ALM', x: SCHED_X, y: 0.160 },  // echo only
  ];
  const devices = reconcile(catalog, labelInstances, [], scheduleRows, { planRegions: [boxA] });

  const u = get(devices, 'ALM-U'), v = get(devices, 'ALM-V');
  assert(u && u.x === 0.70 && u.y === 0.62,
    `ALM-U placed on its stamp even though its plan was un-boxed (got ${u && u.x},${u && u.y})`);
  assert(u && u.x !== SCHED_X, 'ALM-U did NOT fall back to the schedule echo');
  assert(v && v.x == null && v.flags.includes('needs_placement'),
    'ALM-V (echo only, no stamp) -> needs_placement, not parked on the table');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
