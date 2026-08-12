// waypoint-path.js — Tier 1 cable-routing path builder: greedy nearest-neighbor walk
// through a page's waypoint pool. Pure geometry only — the caller supplies coordinates
// already converted to a consistent linear unit (e.g. PDF points), so this module has
// no notion of normalized space, page dimensions, or scale. No DOM, no network.
//
// Algorithm (documented tradeoff, not true shortest-path): from the current position,
// repeatedly step to the NEAREST remaining waypoint that makes genuine progress —
// i.e. is strictly closer to the demarc than the current position is. A waypoint that
// doesn't reduce remaining distance (behind the device, off to the side away from the
// destination) is never a valid step, even if it happens to be physically close;
// without that constraint, pure nearest-to-current-position greedy can detour
// backward to a nearby-but-irrelevant waypoint (caught by test-waypoint-path.mjs).
// Terminates when no remaining waypoint makes progress, at which point the path steps
// straight to the demarc. A device near no relevant waypoint routes straight to the
// demarc, unchanged from the pre-waypoint straight-line behavior — pages with no
// waypoints are byte-for-byte the same result as before.
//
// Known limitation (by design, for v1): greedy nearest-neighbor can produce a
// suboptimal (non-shortest) path when waypoints are dense or ambiguous — e.g. two
// nearby-but-unrelated trays could get crossed. If that shows up in practice, the fix
// is an explicit connectivity graph (Tier 2) or tracing real tray/conduit vector
// geometry from the PDF (Tier 3), not tuning this heuristic further.
//
// The SAME waypoint pool serves every device on a page — nothing here "claims" a
// waypoint across calls, so many devices sharing one tray entry point all route through
// it independently, each with their own full pool to choose from.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Build a routed path from a device to its assigned demarc via zero or more waypoints.
 *
 * @param {[number,number]} deviceXY   device position, [x, y]
 * @param {Array}           waypoints  candidate pool for this page: [{ id, x, y }]
 * @param {[number,number]} demarcXY   the assigned demarc/exit pin position, [x, y]
 * @returns {{
 *   points: Array<[number,number]>,      device -> ... -> demarc, inclusive
 *   legs: Array<{from,to,dist}>,         each straight segment of the route
 *   total_dist: number|null,             sum of leg lengths, same unit as input coords
 *   waypoint_ids_used: Array             ids of waypoints the path passed through, in order
 * }}
 */
export function buildGreedyPath(deviceXY, waypoints = [], demarcXY) {
  if (!Array.isArray(deviceXY) || deviceXY.length < 2 ||
      !Array.isArray(demarcXY) || demarcXY.length < 2 ||
      !Number.isFinite(deviceXY[0]) || !Number.isFinite(deviceXY[1]) ||
      !Number.isFinite(demarcXY[0]) || !Number.isFinite(demarcXY[1])) {
    return { points: [], legs: [], total_dist: null, waypoint_ids_used: [] };
  }

  const pool = (waypoints || []).filter(
    (w) => w && Number.isFinite(w.x) && Number.isFinite(w.y)
  );

  const points = [deviceXY];
  const legs = [];
  const waypoint_ids_used = [];
  let current = deviceXY;
  let remaining = pool.slice();
  let total_dist = 0;

  // Cap iterations at pool.length + 1 (one step per waypoint, plus the final step to
  // the demarc) so a malformed input can never loop — the pool strictly shrinks by one
  // every waypoint-step, and the demarc-step always breaks.
  for (let i = 0; i <= pool.length; i++) {
    const demarcDist = dist(current, demarcXY);

    // Only a waypoint that's strictly closer to the demarc than `current` is counts as
    // progress — this is what rules out backward/irrelevant detours (see header note).
    let bestWp = null, bestWpDist = Infinity, bestWpIdx = -1;
    remaining.forEach((w, idx) => {
      const wXY = [w.x, w.y];
      if (dist(wXY, demarcXY) >= demarcDist) return;   // not on the way — never a candidate
      const d = dist(current, wXY);
      if (d < bestWpDist) { bestWpDist = d; bestWp = w; bestWpIdx = idx; }
    });

    if (bestWp) {
      const to = [bestWp.x, bestWp.y];
      points.push(to);
      legs.push({ from: current, to, dist: bestWpDist });
      total_dist += bestWpDist;
      waypoint_ids_used.push(bestWp.id ?? null);
      current = to;
      remaining.splice(bestWpIdx, 1);
    } else {
      points.push(demarcXY);
      legs.push({ from: current, to: demarcXY, dist: demarcDist });
      total_dist += demarcDist;
      break;
    }
  }

  return { points, legs, total_dist: Math.round(total_dist * 1000) / 1000, waypoint_ids_used };
}

export default { buildGreedyPath };
