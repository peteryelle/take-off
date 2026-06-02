// signature.js — pure vector-geometry classifier for the v2 detection contract.
// No PDF, no DOM, no network, no LLM. Same style as detect/reconcile/schedule.
// Imported by both pipelines, the symbol-locate path, and the cluster-and-ring tool.
//
// This is the deterministic ENGINE for the hard CLASSIFICATION call — telling
// near-identical symbols apart by geometry (the 1-lens / 3-lens / 4-lens camera
// case that the LLM description path got wrong). It NEVER locates a glyph and it
// NEVER reads a color; a caller (vector blob-find or the LLM strip locator)
// hands it the sub-paths of ONE already-isolated glyph, and it returns either a
// type with a score or an explicit `no_match` — it must never force nearest-of-N.
//
// LOCATION vs CLASSIFICATION (the core lesson): location = "there is a glyph
// here" (recall job, LLM or blob-find); classification = "it is a 4-lens" (this
// module). Keep them separate. Match against PLAN exemplars (real on-plan
// instances), not legend glyphs — the legend is for naming only.
//
// ── Data contract ─────────────────────────────────────────────────
// Blob (one glyph): { paths: [SubPath, ...] }
//   SubPath: { points: [[x,y], ...], closed?: bool, filled?: bool }
//     points are FLATTENED polylines in any single 2D space (beziers already
//     subdivided by the adapter); units/rotation/translation are irrelevant —
//     every feature below is translation-, scale-, and rotation-invariant.
//
// Signature (rotation/scale-invariant feature vector):
//   { lobe_count, n_subpaths, aspect, area_ratio, fill_ratio, spikiness, envelope }
//     lobe_count  — dominant feature: radial cone/lobe count around the centroid
//     n_subpaths  — sub-path count (QTS camera = 2)
//     aspect      — PCA principal-axis extent ratio (>=1; rotation-invariant)
//     area_ratio  — summed |signed area| of closed sub-paths / bbox-ish area
//     fill_ratio  — fraction of sub-paths flagged filled
//     spikiness   — max/median of the angular radius envelope (cone sharpness)
//     envelope    — normalized angular max-radius profile (kept for the ring tool)

const TWO_PI = Math.PI * 2;
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function allPoints(blob) {
  const pts = [];
  for (const sp of blob.paths || []) for (const p of sp.points || []) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push(p);
  }
  return pts;
}

function centroid(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

// Shoelace area of a closed polyline (absolute).
function polyArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// PCA principal-axis extent ratio (rotation-invariant aspect). >=1.
function pcaAspect(pts, [cx, cy]) {
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const n = pts.length || 1;
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  const l2 = tr / 2 - Math.sqrt(disc);
  if (l1 <= 0 || l2 <= 0) return 1;
  return Math.sqrt(l1 / l2);
}

// Angular max-radius envelope: for each angular bin, the farthest path radius
// at that angle. Built by walking every polyline SEGMENT and sampling ALONG it
// (not just at vertices) — a segment from hub-rim to cone-tip sweeps its angular
// span with rising radius, so a cone reads as a proper triangular lobe regardless
// of how few vertices the path has. Any still-empty bins are filled by circular
// interpolation. Translation handled by the caller's centroid; the profile is in
// raw units (scale handled later by median-normalization).
function angularEnvelope(paths, [cx, cy], bins, diag) {
  const env = new Array(bins).fill(0);
  const seen = new Array(bins).fill(false);
  const step = Math.max(diag / (bins * 2), 1e-9); // sub-bin angular resolution
  const put = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    let a = Math.atan2(dy, dx); if (a < 0) a += TWO_PI;
    const b = Math.min(bins - 1, Math.floor((a / TWO_PI) * bins));
    if (r > env[b]) env[b] = r;
    seen[b] = true;
  };
  for (const sp of paths) {
    const pts = sp.points || [];
    const m = pts.length;
    if (!m) continue;
    const edges = m + (sp.closed && m > 2 ? 0 : -1); // closed: wrap last->first
    for (let i = 0; i < (sp.closed && m > 2 ? m : m - 1); i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % m];
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.min(256, Math.max(2, Math.ceil(segLen / step)));
      for (let k = 0; k <= n; k++) { const t = k / n; put(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t); }
    }
    if (m === 1) put(pts[0][0], pts[0][1]);
  }
  return fillGapsCircular(env, seen);
}

// Fill unseen bins by linear interpolation between the nearest seen bins on each
// side (circular). If nothing was seen, returns zeros.
function fillGapsCircular(env, seen) {
  const n = env.length;
  if (seen.every((s) => !s)) return env;
  const out = env.slice();
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    let lo = 1; while (!seen[(i - lo + n) % n]) lo++;
    let hi = 1; while (!seen[(i + hi) % n]) hi++;
    const vLo = env[(i - lo + n) % n], vHi = env[(i + hi) % n];
    out[i] = vLo + (vHi - vLo) * (lo / (lo + hi)); // linear across the gap
  }
  return out;
}

// Small circular moving-average smooth (so one wide cone isn't split in two).
function smoothCircular(arr, win) {
  const n = arr.length, half = win >> 1, out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) s += arr[(i + k + n) % n];
    out[i] = s / (2 * half + 1);
  }
  return out;
}

// Count circular runs of the envelope above `threshold` — each run is one lobe.
// Run-counting (not peak-finding) is robust to cone width and avoids splitting.
function countLobes(env, threshold) {
  const n = env.length;
  const above = env.map((v) => v > threshold);
  if (above.every(Boolean)) return above.some(Boolean) ? 1 : 0; // flat-high ring => 0 distinct lobes
  let runs = 0;
  for (let i = 0; i < n; i++) {
    const prev = above[(i - 1 + n) % n];
    if (above[i] && !prev) runs++;
  }
  return runs;
}

/**
 * Compute the rotation/scale-invariant signature of one isolated glyph.
 * @param {Object} blob  { paths: [{ points:[[x,y]...], closed?, filled? }] }
 * @param {Object} opts  { bins=72, smoothWin=3, spikeRatio=1.6 }
 * @returns {Object} signature (see header)
 */
export function computeSignature(blob = {}, opts = {}) {
  const bins = opts.bins ?? 72;
  const smoothWin = opts.smoothWin ?? 3;
  const spikeRatio = opts.spikeRatio ?? 1.6;

  const paths = Array.isArray(blob.paths) ? blob.paths : [];
  const pts = allPoints(blob);
  const empty = {
    lobe_count: 0, n_subpaths: paths.length, aspect: 1,
    area_ratio: 0, fill_ratio: 0, spikiness: 1, envelope: new Array(bins).fill(0),
  };
  if (pts.length < 3) return empty;

  const c = centroid(pts);
  // bbox + diagonal (used both for segment sampling resolution and area_ratio).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const bboxArea = Math.max((maxX - minX) * (maxY - minY), 1e-9);
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;

  const rawEnv = smoothCircular(angularEnvelope(paths, c, bins, diag), smoothWin);
  const med = median(rawEnv.filter((v) => v > 0)) || 1e-9;
  const mx = Math.max(...rawEnv, 1e-9);
  // Hub-relative envelope: hub bins ~1.0, a cone spikes to ~2.5, a square's
  // corner only reaches ~1.4 — so a prominence threshold cleanly separates a
  // cone from mere convex-hull corners. Count circular runs above spikeRatio.
  const medEnv = rawEnv.map((v) => v / med);
  const lobe_count = countLobes(medEnv, spikeRatio);

  let filledN = 0, polyA = 0;
  for (const sp of paths) {
    if (sp.filled) filledN++;
    if ((sp.points || []).length >= 3) polyA += polyArea(sp.points);
  }

  return {
    lobe_count,
    n_subpaths: paths.length,
    aspect: pcaAspect(pts, c),
    area_ratio: Math.min(1, polyA / bboxArea),
    fill_ratio: paths.length ? filledN / paths.length : 0,
    spikiness: mx / med,
    envelope: rawEnv.map((v) => v / mx),
  };
}

// Weighted, rotation-invariant feature distance. lobe_count dominates: a single
// lobe of difference already exceeds the default tolerance, so a glyph can never
// be forced onto a prototype with the wrong cone count.
const W = { lobe: 1.0, subpaths: 0.15, aspect: 0.2, area: 0.25, fill: 0.2, spike: 0.1 };

export function sigDistance(a, b) {
  const relAspect = Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect, 1e-9);
  const relSpike = Math.abs(a.spikiness - b.spikiness) / Math.max(a.spikiness, b.spikiness, 1e-9);
  return (
    W.lobe * Math.abs(a.lobe_count - b.lobe_count) +
    W.subpaths * Math.abs(a.n_subpaths - b.n_subpaths) +
    W.aspect * relAspect +
    W.area * Math.abs(a.area_ratio - b.area_ratio) +
    W.fill * Math.abs(a.fill_ratio - b.fill_ratio) +
    W.spike * relSpike
  );
}

/**
 * Classify a glyph signature against a set of plan-exemplar prototypes.
 * @param {Object} sig         signature from computeSignature
 * @param {Array}  prototypes  [{ type, sig }]  (sig also from computeSignature)
 * @param {number} tol         max distance to accept a match (default 0.6)
 * @returns {Object} { type, score, match } — type=null & match:'no_match' when
 *          nothing is within tol. Unknown glyphs are surfaced, never coerced.
 */
export function classifyBlob(sig, prototypes = [], tol = 0.6) {
  let best = null, bestD = Infinity;
  for (const p of prototypes) {
    const d = sigDistance(sig, p.sig);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best || bestD > tol) {
    return { type: null, score: best ? round3(bestD) : null, match: 'no_match' };
  }
  return { type: best.type, score: round3(bestD), match: 'matched' };
}

// Average exemplar signatures into one prototype — backs "save as exemplar":
// resolving one case with the ring tool improves the automated pass for the rest.
export function prototypeFromSignatures(type, sigs = []) {
  if (!sigs.length) return { type, sig: null, n: 0 };
  const mean = (k) => sigs.reduce((s, x) => s + (x[k] ?? 0), 0) / sigs.length;
  return {
    type, n: sigs.length,
    sig: {
      lobe_count: Math.round(mean('lobe_count')),
      n_subpaths: Math.round(mean('n_subpaths')),
      aspect: mean('aspect'),
      area_ratio: mean('area_ratio'),
      fill_ratio: mean('fill_ratio'),
      spikiness: mean('spikiness'),
      envelope: [],
    },
  };
}

const round3 = (v) => parseFloat(Number(v).toFixed(3));

export default computeSignature;
