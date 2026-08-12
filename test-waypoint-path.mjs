// test-waypoint-path.mjs — OFFLINE gate for the Tier 1 greedy waypoint router.
// Pure geometry, no fixtures needed — hand-built cases cover: no waypoints (exact
// back-compat with the pre-waypoint straight line), one waypoint on the way, a waypoint
// that's NOT on the way (should be skipped), a multi-hop chain, and a shared pool
// serving two different devices independently (no cross-device state).
// Run: node test-waypoint-path.mjs

import { buildGreedyPath } from './public/lib/waypoint-path.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

console.log('No waypoints on the page — exact back-compat with straight-line distance:');
{
  const r = buildGreedyPath([0, 0], [], [10, 0]);
  assert(r.points.length === 2, 'path is [device, demarc] only (got ' + r.points.length + ')');
  assert(close(r.total_dist, 10), 'total_dist == straight distance 10 (got ' + r.total_dist + ')');
  assert(r.waypoint_ids_used.length === 0, 'no waypoints used');
}

console.log('One waypoint genuinely on the way — path routes through it:');
{
  // device at (0,0), waypoint at (5,0), demarc at (10,0) — waypoint sits exactly
  // on the straight line, so routing through it changes nothing distance-wise but
  // MUST still be chosen (it's strictly nearer than the demarc from the device).
  const r = buildGreedyPath([0, 0], [{ id: 'wp1', x: 5, y: 0 }], [10, 0]);
  assert(r.waypoint_ids_used.length === 1 && r.waypoint_ids_used[0] === 'wp1', 'routed through wp1 (got ' + JSON.stringify(r.waypoint_ids_used) + ')');
  assert(close(r.total_dist, 10), 'total_dist == 10 (on-line waypoint adds nothing, got ' + r.total_dist + ')');
  assert(r.points.length === 3, '3 points: device, wp1, demarc (got ' + r.points.length + ')');
}

console.log('A waypoint that is NOT on the way (behind the device, wrong direction) is skipped:');
{
  // device at (0,0), demarc at (10,0). A waypoint at (-5,0) is FARTHER from the
  // device than the demarc is at every step — greedy must never detour to it.
  const r = buildGreedyPath([0, 0], [{ id: 'wp_behind', x: -5, y: 0 }], [10, 0]);
  assert(r.waypoint_ids_used.length === 0, 'wp_behind not used (got ' + JSON.stringify(r.waypoint_ids_used) + ')');
  assert(close(r.total_dist, 10), 'total_dist == straight 10, unaffected by the irrelevant waypoint (got ' + r.total_dist + ')');
}

console.log('Multi-hop chain — device routes through two waypoints in the correct order:');
{
  // A right-angle run: device (0,0) -> tray entry (0,8) -> passthrough (6,8) -> demarc (6,10).
  // Straight-line device->demarc would be sqrt(36+100)=~11.66; the real routed path is
  // 8 + 6 + 2 = 16, which is what a tray-following run actually costs — this is exactly
  // the case a flat straight-line-times-fudge-factor estimate gets wrong in either
  // direction depending on the room layout.
  const wps = [{ id: 'entry', x: 0, y: 8 }, { id: 'pass', x: 6, y: 8 }];
  const r = buildGreedyPath([0, 0], wps, [6, 10]);
  assert(JSON.stringify(r.waypoint_ids_used) === JSON.stringify(['entry', 'pass']), 'order is entry then pass (got ' + JSON.stringify(r.waypoint_ids_used) + ')');
  assert(close(r.total_dist, 16), 'total_dist == 16 (8+6+2) (got ' + r.total_dist + ')');
  assert(r.points.length === 4, '4 points: device, entry, pass, demarc (got ' + r.points.length + ')');
}

console.log('Shared waypoint pool — two devices route independently, no cross-device state:');
{
  const wps = [{ id: 'shared', x: 5, y: 0 }];
  const rA = buildGreedyPath([0, 0], wps, [10, 0]);
  const rB = buildGreedyPath([0, 1], wps, [10, 1]);
  assert(rA.waypoint_ids_used[0] === 'shared', 'device A used the shared waypoint');
  assert(rB.waypoint_ids_used[0] === 'shared', 'device B ALSO used the shared waypoint (not consumed by A) (got ' + JSON.stringify(rB.waypoint_ids_used) + ')');
}

console.log('Malformed input degrades safely, never throws:');
{
  const r1 = buildGreedyPath(null, [{ id: 'x', x: 1, y: 1 }], [10, 0]);
  assert(r1.total_dist === null, 'null device -> total_dist null, no throw');
  const r2 = buildGreedyPath([0, 0], [{ id: 'bad', x: NaN, y: 1 }], [10, 0]);
  assert(close(r2.total_dist, 10), 'a malformed waypoint is filtered out, falls back to straight line (got ' + r2.total_dist + ')');
}

console.log();
console.log(failures === 0 ? 'ALL GATES PASS' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
