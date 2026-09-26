// tests/test-route-modes.mjs — WF4 cable-length modes (one multiplier per mode)
// Run: node tests/test-route-modes.mjs
import { effectiveRouting, measure, lengthsFt, DEFAULT_MULTIPLIERS } from '../public/lib/route-modes.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};
const proj = { route_mode: 'straight', straight_multiplier: 1.05, right_angle_multiplier: 1.10, routed_multiplier: 1.35 };

// mode: sheet > project > straight
eq('default', effectiveRouting({}, {}), { mode: 'straight', multiplier: 1.35 });
eq('defaults per mode', DEFAULT_MULTIPLIERS, { straight: 1.35, right_angle: 1.2, routed: 1.1 });
eq('project straight', effectiveRouting(proj, {}), { mode: 'straight', multiplier: 1.05 });
eq('project right-angle uses its own', effectiveRouting({ ...proj, route_mode: 'right_angle' }, {}), { mode: 'right_angle', multiplier: 1.1 });
eq('project routed uses its own', effectiveRouting({ ...proj, route_mode: 'routed' }, {}), { mode: 'routed', multiplier: 1.35 });
// sheet overrides
eq('sheet mode picks that mode\'s multiplier', effectiveRouting(proj, { route_mode: 'right_angle' }), { mode: 'right_angle', multiplier: 1.1 });
eq('sheet multiplier replaces it', effectiveRouting(proj, { route_mode: 'routed', route_multiplier: 1.5 }), { mode: 'routed', multiplier: 1.5 });
eq('sheet multiplier only', effectiveRouting(proj, { route_multiplier: 1.2 }), { mode: 'straight', multiplier: 1.2 });
// fallbacks
eq('missing mode multiplier -> default', effectiveRouting({ route_mode: 'routed' }, {}), { mode: 'routed', multiplier: 1.1 });
eq('bad values fall back', effectiveRouting({ route_mode: 'diagonal', straight_multiplier: -2 }, { route_multiplier: 0 }), { mode: 'straight', multiplier: 1.35 });
eq('numeric string multiplier', effectiveRouting({ straight_multiplier: '1.15' }, {}).multiplier, 1.15);
eq('right-angle default', effectiveRouting({ route_mode: 'right_angle' }, {}), { mode: 'right_angle', multiplier: 1.2 });

// geometry: 3-4-5 triangle
const d = [0, 0], p = [300, 400];
eq('straight dist', measure('straight', d, p).dist_pts, 500);
eq('right-angle dist', measure('right_angle', d, p).dist_pts, 700);
eq('right-angle path', measure('right_angle', d, p).points, [[0, 0], [300, 0], [300, 400]]);
const router = () => ({ total_dist: 620, points: [[0, 0], [100, 50], [300, 400]], _tier3: true, waypoint_ids_used: [] });
eq('routed uses router', measure('routed', d, p, router), { dist_pts: 620, points: [[0, 0], [100, 50], [300, 400]], tier3: true, waypoint_ids: null });
eq('routed unreachable -> straight', measure('routed', d, p, () => ({ total_dist: null })).dist_pts, 500);
eq('straight ignores router', measure('straight', d, p, router).dist_pts, 500);

// lengths: 72 pts per ft (1" = 1')
eq('lengths straight', lengthsFt(720, 72, 1, 10), { route_ft_raw: 10, run_ft: 10, route_ft: 20 });
eq('lengths with multiplier', lengthsFt(720, 72, 1.1, 0), { route_ft_raw: 10, run_ft: 11, route_ft: 11 });
eq('lengths no scale', lengthsFt(720, null, 1, 10), { route_ft_raw: null, run_ft: null, route_ft: null });

// Straight line at its default (1.35) must equal the old pass-batch formula on a
// page with no waypoints / wall routing (where the old router fell back to the
// straight line):  run = parseFloat((dist * 1.35 / ptsPerFt).toFixed(1)); total = run + stub
let mismatches = 0, seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const straightDefault = effectiveRouting({}, {}).multiplier;
for (let i = 0; i < 5000; i++) {
  const dist = rnd() * 20000, ppf = 1 + rnd() * 30, stub = Math.round(rnd() * 200 * 10) / 10;
  const oldRun = parseFloat((dist * 1.35 / ppf).toFixed(1));
  const oldTotal = parseFloat((oldRun + stub).toFixed(1));
  const L = lengthsFt(dist, ppf, straightDefault, stub);
  if (L.run_ft !== oldRun || L.route_ft !== oldTotal) mismatches++;
}
eq('straight default == old formula (5000 random cases)', mismatches, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
