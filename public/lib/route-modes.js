// public/lib/route-modes.js
// WF4 cable-length modes. Pure functions — no DOM, no database — shared by the
// WF4 batch pass and any client that previews lengths.
//
//   straight     device -> TR pin, straight line          (default mode)
//   right_angle  one horizontal + one vertical leg
//   routed       existing wall-aware / waypoint routing
//
// Each mode has its own user-set multiplier on the project
// (straight_multiplier, right_angle_multiplier, routed_multiplier).
// Defaults: 1.00, 1.00, 1.35 — routed's 1.35 is the old app's route factor,
// so routed lengths match today's until someone edits it.
// A sheet may override its mode and/or multiplier (pages.route_mode,
// pages.route_multiplier). The sheet multiplier replaces the mode's multiplier.
//
// Distances are in PDF points; `ptsPerFt` converts to feet. The TR pin's stub
// (fixed off-sheet distance) is added after the multiplier, as before.
// ─────────────────────────────────────────────────────────────────

export const ROUTE_MODES = ['straight', 'right_angle', 'routed'];
export const DEFAULT_MULTIPLIERS = { straight: 1.00, right_angle: 1.00, routed: 1.35 };

const positive = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && n > 0 ? n : null; };

// Mode: sheet override > project > straight.
// Multiplier: sheet override > project's multiplier for that mode > default for that mode.
export function effectiveRouting(project = {}, page = {}) {
  const mode = ROUTE_MODES.includes(page?.route_mode) ? page.route_mode
    : ROUTE_MODES.includes(project?.route_mode) ? project.route_mode : 'straight';
  const multiplier = positive(page?.route_multiplier)
    ?? positive(project?.[`${mode}_multiplier`])
    ?? DEFAULT_MULTIPLIERS[mode];
  return { mode, multiplier };
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
//   route_ft_raw = measured length, no multiplier
//   run_ft       = raw x multiplier               (old run_length_ft)
//   route_ft     = run_ft + stub                  (old total_ft)
export function lengthsFt(distPts, ptsPerFt, multiplier, stubFt = 0) {
  if (!Number.isFinite(distPts) || !(ptsPerFt > 0)) return { route_ft_raw: null, run_ft: null, route_ft: null };
  const round = (v) => parseFloat(v.toFixed(1));
  const run = round(distPts * multiplier / ptsPerFt);
  return { route_ft_raw: round(distPts / ptsPerFt), run_ft: run, route_ft: round(run + (Number(stubFt) || 0)) };
}
