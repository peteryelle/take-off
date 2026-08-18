// public/lib/pipeline-guards.js
// ─────────────────────────────────────────────────────────────────
// Small, pure guard/resolver functions extracted from pass-batch.js.
// Both were originally inline in the handler, which meant neither had a
// real fixture gate — and the same bug class (Number(null) is 0, which
// IS finite, so a naive Number.isFinite(Number(x)) check silently treats
// "unset" as "explicitly zero") hit this file twice in one session:
// once in the distance/total_ft handling, once in the first pass at
// resolveTiaLimit below. Pulling these out so they're testable like
// every other pure module in lib/, instead of trusting hand-tracing
// inline handler code a third time.
// ─────────────────────────────────────────────────────────────────

// True if detection can proceed for this page: either it already has a
// saved scale, or a valid scale_override was supplied on this request.
export function hasUsableScale(page, scaleOverride) {
  const hasExistingScale = Number.isFinite(page?.scale_pts_per_ft) && page.scale_pts_per_ft > 0;
  const hasOverrideScale = !!scaleOverride
    && Number.isFinite(scaleOverride.paper_value)
    && Number.isFinite(scaleOverride.real_value)
    && scaleOverride.real_value > 0;
  return hasExistingScale || hasOverrideScale;
}

// TIA permanent-link limit (ft) for a device type. tiaLimitFt is
// device_types.tia_limit_ft — nullable; null/undefined means "no override,
// use the pipeline default" and must NOT be coerced through Number() before
// the null check, since Number(null) === 0, which passes Number.isFinite.
// An explicit 0 is deliberately still honored as a real (if unusual) value,
// distinct from "unset" — only null/undefined fall back.
export function resolveTiaLimit(tiaLimitFt, fallback = 295) {
  if (tiaLimitFt == null) return fallback;
  const n = Number(tiaLimitFt);
  return Number.isFinite(n) ? n : fallback;
}
