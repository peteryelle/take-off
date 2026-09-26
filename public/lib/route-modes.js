// public/lib/route-modes.js
// WF4 cable-length modes. Pure functions — no DOM, no database — shared by the
// WF4 batch pass and any client that previews lengths.
//
//   straight     device -> TR pin, straight line            x multiplier (default 1.00)
//   right_angle  one horizontal + one vertical leg           x multiplier
//   routed       existing wall-aware / waypoint routing      x ROUTED_FACTOR x multiplier
//
// Routed keeps the old app's 1.35 route factor so its lengths stay identical to
// today's (which have been validated). The project/sheet multiplier applies on
// top of it; at the default 1.00 nothing changes.
//
// Distances are in PDF points; `ptsPerFt` converts to feet. The TR pin's stub
// (fixed off-sheet distance) is added after the multiplier, as before.
// ─────────────────────────────────────────────────────────────────

export const ROUTE_MODES = ['straight', 'right_angle', 'routed'];
export const ROUTED_FACTOR = 1.35;

// Sheet override wins over the project setting; anything invalid falls back
// to the defaults (straight line at 100%).
export function effectiveRouting(project = {}, page = {}) {
  const mode = ROUTE_MODES.includes(page?.route_mode) ? page.route_mode
    : ROUTE_MODES.includes(project?.route_mode) ? project.route_mode : 'straight';
  const m = Number(page?.route_multiplier ?? project?.route_multiplier ?? 1);
  const multiplier = Number.isFinite(m) && m > 0 ? m : 1;
  return { mode, multiplier };
}

// The factor actually applied to the measured distance for this mode.
export function appliedFactor(mode, multiplier) {
  return mode === 'routed' ? ROUTED_FACTOR * multiplier : multiplier;
}

// Measure device -> pin in points. `routedFn(deviceXY, pinXY)` is the existing
// router (tier 3 wall-aware, else tier 1 waypoints); only called in routed mode.
// Returns { dist_pts, points, tier3, waypoint_ids }.
export function measure(mode, deviceXY, pinXY, routedFn) {
  const [dx, dy] = deviceXY, [px, py] = pinXY;
  if (mode === 'right_angle') {
    return {
      dist_pts: Math.abs(dx - px) + Math.abs(dy - py),
      points: [[dx, dy], [px, dy], [px, py]],   // horizontal leg first, then vertical
      tier3: false, waypoint_ids: null,
    };
  }
  if (mode === 'routed' && typeof routedFn === 'function') {
    const r = routedFn(deviceXY, pinXY) || {};
    const straight = Math.hypot(dx - px, dy - py);
    return {
      dist_pts: Number.isFinite(r.total_dist) ? r.total_dist : straight,   // never lose a distance to a malformed route
      points: r.points?.length ? r.points : [[dx, dy], [px, py]],
      tier3: !!r._tier3,
      waypoint_ids: r.waypoint_ids_used?.length ? r.waypoint_ids_used : null,
    };
  }
  return { dist_pts: Math.hypot(dx - px, dy - py), points: [[dx, dy], [px, py]], tier3: false, waypoint_ids: null };
}

// Feet, rounded to 0.1 like the old code:
//   route_ft_raw = measured length, no factor
//   run_ft       = raw x applied factor           (old run_length_ft)
//   route_ft     = run_ft + stub                  (old total_ft)
export function lengthsFt(distPts, ptsPerFt, factor, stubFt = 0) {
  if (!Number.isFinite(distPts) || !(ptsPerFt > 0)) return { route_ft_raw: null, run_ft: null, route_ft: null };
  const round = (v) => parseFloat(v.toFixed(1));
  const raw = distPts / ptsPerFt;
  const run = round(distPts * factor / ptsPerFt);
  return { route_ft_raw: round(raw), run_ft: run, route_ft: round(run + (Number(stubFt) || 0)) };
}
