// geometry.js — the vector-geometry ADAPTER for the symbol/classification track.
// No DOM, no network, and (deliberately) no PDF-library import. pdf.js is INJECTED:
// every entry point that needs the operator list takes an already-opened page plus
// that runtime's OPS table, so the browser hands it the CDN `pdfjsLib`, the offline
// gate hands it `pdfjs-dist`, and the LIVE pipeline never gains a server-side PDF
// dependency — extraction runs client-side where pdf.js already parses the document,
// and finished, typed symbol_instances POST to pass-extract (which already threads
// them into reconcile). Single source of truth, imported by index.html, the
// multi-page pipeline, the classify-cameras tool, and the offline gates.
//
// LOCATION vs CLASSIFICATION (the core lesson): this module owns LOCATION for the
// symbol track — operator-list extraction, fill filtering, and grouping sub-paths
// into per-glyph blobs — and delegates the hard CLASSIFICATION call to signature.js.
// It never invents a type; an unmatched glyph is surfaced, never coerced.
//
// Flow:
//   extractFilledSubpaths(page, OPS)            -> raw filled sub-paths (PDF user space)
//   contentFrame(textCenters, vpW, vpH).norm    -> normalize each point to [0,1]
//   filterByFill(subpaths, target, tol)         -> keep the device's fill colour
//   groupSubpaths(subpaths, opts)               -> blobs in the signature.js contract
//   classifyCameraBlob(blob, opts)              -> { type, confidence, flag, ... }
//
// The normalization frame is THE getDeviceTextItems frame, factored out here so the
// text path and the symbol path share one definition — symbols land in the same
// normalized space as text devices and the demarc, or distances would be garbage.

import { computeSignature, countRadialArms, classifyBlob } from './signature.js';

// ── affine + cubic-bezier flattening (PDF content-stream math) ──────────────
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mulM = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const cubic = (p0, p1, p2, p3, n = 12) => {
  const o = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    o.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return o;
};
const centroid = (pts) => {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
};
// Absolute shoelace area of a closed polyline.
export function polyArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * The getDeviceTextItems normalization frame, factored out as the single source.
 * Normalizes by CONTENT bounds (from text-item centres) so drawings whose geometry
 * extends past the PDF MediaBox still map into [0,1]; falls back to the viewport
 * when bounds are smaller. y is flipped (PDF y-up -> image y-down) to match the text
 * path. Anisotropic by design: x and y divide by their own extent, exactly as the
 * text path does, so symbol and text coordinates coincide.
 *
 * @param {Array} textCenters [{ cx, cy }] in PDF user space (text-item centres)
 * @param {number} vpW viewport width  (pdfPage.getViewport({scale:1}).width)
 * @param {number} vpH viewport height
 * @returns {{ xMin, yMin, cW, cH, norm }}  norm(x,y) -> [x_norm, y_norm] rounded to 4dp
 */
export function contentFrame(textCenters = [], vpW = 0, vpH = 0) {
  const xs = textCenters.map((t) => t.cx);
  const ys = textCenters.map((t) => t.cy);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : vpW;
  const yMin = ys.length ? Math.min(...ys) : 0;
  const yMax = ys.length ? Math.max(...ys) : vpH;
  const cW = Math.max(xMax - xMin, vpW);
  const cH = Math.max(yMax - yMin, vpH);
  const norm = (x, y) => [
    parseFloat(((x - xMin) / cW).toFixed(4)),
    parseFloat((1 - (y - yMin) / cH).toFixed(4)),
  ];
  return { xMin, yMin, cW, cH, norm };
}

/**
 * Walk a pdf.js operator list and return every FILLED sub-path with its fill colour,
 * in PDF user space (caller normalizes with contentFrame.norm). Beziers are
 * flattened, rectangles expanded, the CTM stack tracked. pdf.js is injected.
 *
 * @param {Object} page  an opened pdf.js page (has getOperatorList())
 * @param {Object} OPS   that runtime's pdfjsLib.OPS table
 * @returns {Promise<Array>} [{ points:[[x,y]...], closed:true, filled:true, fill_rgb:[r,g,b] }]
 */
export async function extractFilledSubpaths(page, OPS) {
  return (await extractSubpaths(page, OPS)).filter((s) => s.filled);
}

/**
 * Same operator-list walk as extractFilledSubpaths, but keeps BOTH filled and
 * stroke-only sub-paths (tagged filled:true/false) instead of discarding strokes.
 * Added for ring verification (geometry.js:findEncirclingRing) — a symbol's
 * encircling outline is typically drawn as a stroke with no fill, which the
 * fills-only extractor never captured at all. extractFilledSubpaths is now a
 * one-line wrapper over this, so its existing return shape/contract is
 * untouched — no existing consumer or gate sees a behavior change from adding
 * this function.
 *
 * @param {Object} page  an opened pdf.js page (has getOperatorList())
 * @param {Object} OPS   that runtime's pdfjsLib.OPS table
 * @returns {Promise<Array>} [{ points:[[x,y]...], closed:true, filled:bool, fill_rgb:[r,g,b] }]
 */
export async function extractSubpaths(page, OPS) {
  const { fnArray, argsArray } = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let fill = [0, 0, 0];
  let cur = [];
  let pt = null;
  const out = [];
  const startSub = (x, y) => { cur.push({ points: [[x, y]] }); pt = [x, y]; };
  const lineTo = (x, y) => { if (!cur.length) startSub(x, y); else { cur[cur.length - 1].points.push([x, y]); pt = [x, y]; } };
  const flush = (f) => {
    for (const sp of cur) if (sp.points.length >= 2) out.push({ points: sp.points, closed: true, filled: f, fill_rgb: fill.slice() });
    cur = []; pt = null;
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm.slice()); break;
      case OPS.restore: if (stack.length) ctm = stack.pop(); break;
      case OPS.transform: ctm = mulM(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]); break;
      case OPS.setFillRGBColor: fill = [a[0], a[1], a[2]]; break;
      case OPS.setFillGray: fill = [Math.round(a[0] * 255), Math.round(a[0] * 255), Math.round(a[0] * 255)]; break;
      case OPS.setFillCMYKColor: { const [c, m, y, k] = a; fill = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round); break; }
      case OPS.constructPath: {
        const ops = a[0], co = a[1]; let j = 0;
        for (const op of ops) {
          if (op === OPS.moveTo) { const [x, y] = applyM(ctm, co[j++], co[j++]); startSub(x, y); }
          else if (op === OPS.lineTo) { const [x, y] = applyM(ctm, co[j++], co[j++]); lineTo(x, y); }
          else if (op === OPS.curveTo) { const c1 = applyM(ctm, co[j++], co[j++]), c2 = applyM(ctm, co[j++], co[j++]), e = applyM(ctm, co[j++], co[j++]); if (pt) for (const p of cubic(pt, c1, c2, e)) lineTo(p[0], p[1]); else lineTo(e[0], e[1]); }
          else if (op === OPS.curveTo2) { const c2 = applyM(ctm, co[j++], co[j++]), e = applyM(ctm, co[j++], co[j++]); if (pt) for (const p of cubic(pt, pt, c2, e)) lineTo(p[0], p[1]); else lineTo(e[0], e[1]); }
          else if (op === OPS.curveTo3) { const c1 = applyM(ctm, co[j++], co[j++]), e = applyM(ctm, co[j++], co[j++]); if (pt) for (const p of cubic(pt, c1, e, e)) lineTo(p[0], p[1]); else lineTo(e[0], e[1]); }
          else if (op === OPS.rectangle) { const x = co[j++], y = co[j++], w = co[j++], h = co[j++]; const c = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => applyM(ctm, px, py)); cur.push({ points: [...c, c[0]] }); pt = c[c.length - 1]; }
          else if (op === OPS.closePath) { if (cur.length) { const p = cur[cur.length - 1].points; if (p.length) p.push(p[0].slice()); } }
        }
        break;
      }
      case OPS.fill: case OPS.eoFill: flush(true); break;
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: flush(true); break;
      case OPS.stroke: case OPS.closeStroke: flush(false); break;
      case OPS.endPath: cur = []; pt = null; break;
    }
  }
  return out;
}

/** Keep sub-paths whose fill colour is within `tol` (per channel) of `target` [r,g,b]. */
export function filterByFill(subpaths = [], target = null, tol = 48) {
  if (!target) return subpaths.slice();
  return subpaths.filter((s) => Array.isArray(s.fill_rgb) && s.fill_rgb.every((v, i) => Math.abs(v - target[i]) <= tol));
}

/**
 * Is this closed point-loop roughly circular — constant radius from its own
 * centroid, within `tol` (relative standard deviation of the radius samples)?
 * PDF vector circles are drawn precisely (not scanned/rasterized), so a tight
 * default tolerance is safe. Too few points to judge (a triangle, a short
 * segment) returns null rather than a false circle call.
 *
 * @param {Array} points [[x,y]...] closed loop, any consistent coordinate frame
 * @param {number} tol   relative std-dev of radius allowed (default 0.15)
 * @returns {{center:[x,y], radius:number}|null}
 */
/**
 * Diagnostic only, never used in the accept/reject or debugRingCandidates path —
 * every stroke subpath whose OWN centroid falls within `radius` of `point`,
 * regardless of whether isCircleLike accepts it. Built to distinguish "there's no
 * stroke geometry anywhere near this device at all" from "there IS geometry
 * nearby but it's failing the circle-shape check" — the two have very different
 * fixes (capture gap vs. tolerance/shape-detection gap) and debugRingCandidates
 * alone (which only reports already-circle-classified matches, however far away)
 * can't tell them apart when NOTHING nearby passes the shape check.
 *
 * @returns {Array} [{ n_points, dCenter, isCircle:bool }] sorted by dCenter
 */
export function debugNearbyStrokes(point, strokeSubpaths = [], radius = 0.02) {
  const out = [];
  for (const sp of strokeSubpaths) {
    if (!sp.points?.length) continue;
    const c = centroid(sp.points);
    const dCenter = Math.hypot(c[0] - point[0], c[1] - point[1]);
    if (dCenter <= radius) {
      out.push({ n_points: sp.points.length, dCenter, isCircle: !!isCircleLike(sp.points) });
    }
  }
  return out.sort((a, b) => a.dCenter - b.dCenter);
}

export function isCircleLike(points, tol = 0.15) {
  if (!Array.isArray(points) || points.length < 8) return null;
  const c = centroid(points);
  const radii = points.map(([x, y]) => Math.hypot(x - c[0], y - c[1]));
  const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (meanR <= 0) return null;
  const variance = radii.reduce((a, r) => a + (r - meanR) ** 2, 0) / radii.length;
  const relStd = Math.sqrt(variance) / meanR;
  return relStd <= tol ? { center: c, radius: meanR } : null;
}

/**
 * Does some stroke-only sub-path form a circle that genuinely WRAPS AROUND this
 * blob — center close to the blob's own centroid, radius meaningfully bigger
 * (not just any nearby circle, and not one so much bigger it's clearly an
 * unrelated feature elsewhere on the sheet)? Ring verification for symbol types
 * whose real glyph is a filled shape inside a circular outline (e.g. WAP) — the
 * outline is typically an unfilled stroke, which extractFilledSubpaths never
 * captured; extractSubpaths(...).filter(s => !s.filled) is the intended source
 * for `strokeSubpaths` here.
 *
 * @param {[number,number]} blobCentroid  the candidate blob's [x,y] (normalized)
 * @param {number} blobRadius             the blob's own rough radius (e.g. sqrt(area/PI))
 * @param {Array} strokeSubpaths          [{points, filled:false, ...}] normalized, same frame
 * @param {Object} opts { centerTol, minRadiusRatio=1.1, maxRadiusRatio=3.0 }
 * @returns {{center, radius}|null} the matching ring, or null if none found
 */
/**
 * Chain together short stroke subpaths whose endpoints connect within `tol`,
 * into longer continuous polylines. Real PDF circles are sometimes drawn as
 * many short disconnected segments (each its own moveTo/lineTo/stroke) rather
 * than one closed path — confirmed on a real project: a WAP's encircling ring
 * was 55 separate 2-point pieces, every one individually far too short to
 * read as a circle. Greedy nearest-endpoint chaining, not a full TSP solve —
 * sufficient for "many short pieces of one shape," which is what this exists
 * for, not general curve reconstruction.
 *
 * @param {Array} subpaths [{points:[[x,y]...]}]
 * @param {number} tol     max gap between two endpoints to treat as connected
 * @returns {Array} [{points:[[x,y]...]}] — stitched chains (unmatched inputs
 *   pass through unchanged as their own single-element chain)
 */
export function stitchSegments(subpaths, tol = 0.001) {
  let chains = subpaths.filter((sp) => sp.points?.length >= 2).map((sp) => sp.points.slice());
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < chains.length; i++) {
      const a = chains[i], aStart = a[0], aEnd = a[a.length - 1];
      for (let j = i + 1; j < chains.length; j++) {
        const b = chains[j], bStart = b[0], bEnd = b[b.length - 1];
        let joined = null;
        if (dist(aEnd, bStart) <= tol)        joined = a.concat(b.slice(1));
        else if (dist(aEnd, bEnd) <= tol)     joined = a.concat(b.slice(0, -1).reverse());
        else if (dist(aStart, bEnd) <= tol)   joined = b.concat(a.slice(1));
        else if (dist(aStart, bStart) <= tol) joined = b.slice().reverse().concat(a.slice(1));
        if (joined) { chains.splice(j, 1); chains[i] = joined; merged = true; break outer; }
      }
    }
  }
  return chains.map((points) => ({ points }));
}

/**
 * Does some stroke geometry near this blob form a circle that genuinely WRAPS
 * AROUND it? Restricts to strokes within a local search radius first (cheap
 * even when the page has tens of thousands of unrelated strokes), stitches
 * that local set into continuous chains (see stitchSegments — a real ring is
 * often many short disconnected pieces, not one closed path), THEN checks
 * each stitched chain for the circle shape and size/center match.
 *
 * @param {[number,number]} blobCentroid
 * @param {number} blobRadius
 * @param {Array} strokeSubpaths  [{points, filled:false, ...}] normalized, same frame
 * @param {Object} opts { centerTol, minRadiusRatio=1.1, maxRadiusRatio=3.0, searchRadius, stitchTol }
 * @returns {{center, radius}|null}
 */
export function findEncirclingRing(blobCentroid, blobRadius, strokeSubpaths = [], opts = {}) {
  if (!(blobRadius > 0)) return null;
  const centerTol = opts.centerTol ?? blobRadius * 0.5;
  const minRadiusRatio = opts.minRadiusRatio ?? 1.1;
  const maxRadiusRatio = opts.maxRadiusRatio ?? 3.0;
  const searchRadius = opts.searchRadius ?? blobRadius * (maxRadiusRatio + 1) + centerTol;

  const nearby = strokeSubpaths.filter((sp) => {
    if (!sp.points?.length) return false;
    const c = centroid(sp.points);
    return Math.hypot(c[0] - blobCentroid[0], c[1] - blobCentroid[1]) <= searchRadius;
  });
  const stitched = stitchSegments(nearby, opts.stitchTol ?? 0.001);

  for (const sp of stitched) {
    const circle = isCircleLike(sp.points, opts.circleTol);
    if (!circle) continue;
    const dCenter = Math.hypot(circle.center[0] - blobCentroid[0], circle.center[1] - blobCentroid[1]);
    const ratio = circle.radius / blobRadius;
    if (dCenter <= centerTol && ratio >= minRadiusRatio && ratio <= maxRadiusRatio) return circle;
  }
  return null;
}

/**
 * Fit a straight line through a point set via 2D total-least-squares (closed-form
 * eigen-decomposition of the 2x2 covariance matrix — no linear-algebra library
 * needed at this size). Returns the line's own centroid, unit direction, length
 * (span of points projected onto that direction), and maxResidual (worst
 * perpendicular distance any point sits from the fitted line — the straightness
 * measure).
 */
function fitLine(points) {
  const c = centroid(points);
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) {
    const dx = x - c[0], dy = y - c[1];
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const n = points.length;
  sxx /= n; sxy /= n; syy /= n;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dir = [Math.cos(theta), Math.sin(theta)];
  let minT = Infinity, maxT = -Infinity, maxResidual = 0;
  for (const [x, y] of points) {
    const dx = x - c[0], dy = y - c[1];
    const t = dx * dir[0] + dy * dir[1];
    const perp = Math.abs(-dx * dir[1] + dy * dir[0]);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (perp > maxResidual) maxResidual = perp;
  }
  return { center: c, dir, length: maxT - minT, maxResidual };
}

/**
 * Is this point set (after stitching, typically) a straight line — every point
 * within `straightnessTol` × the line's own length of the fitted line, not just
 * clustered/circular? Needs at least 4 points to be a meaningful fit (a 2-point
 * "line" is trivially straight and would pass everything).
 *
 * @returns {{center, dir, length, maxResidual}|null}
 */
export function isLineLike(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 4) return null;
  const straightnessTol = opts.straightnessTol ?? 0.12;
  const fit = fitLine(points);
  if (!(fit.length > 0)) return null;
  return (fit.maxResidual / fit.length) <= straightnessTol ? fit : null;
}

/**
 * Does some stroke geometry near this blob form a straight line passing through
 * (or very near) its centroid, roughly diameter-length? Same local-neighborhood-
 * filter + stitch pattern as findEncirclingRing (real lines can be drawn as many
 * short disconnected segments too, not just rings) — restrict to a local search
 * radius first, stitch that local set, then fit/check each stitched chain.
 *
 * @param {[number,number]} blobCentroid
 * @param {number} blobRadius
 * @param {Array} strokeSubpaths
 * @param {Object} opts { centerTol, minLenRatio=1.0, maxLenRatio=5.0, searchRadius, stitchTol, straightnessTol }
 * @returns {{center,dir,length,maxResidual}|null}
 */
export function findLineThroughCenter(blobCentroid, blobRadius, strokeSubpaths = [], opts = {}) {
  if (!(blobRadius > 0)) return null;
  const minLenRatio = opts.minLenRatio ?? 1.0;
  const maxLenRatio = opts.maxLenRatio ?? 5.0;
  const centerTol = opts.centerTol ?? blobRadius * 1.0;
  const searchRadius = opts.searchRadius ?? blobRadius * (maxLenRatio + 1) + centerTol;
  const blobDiameter = blobRadius * 2;

  const nearby = strokeSubpaths.filter((sp) => {
    if (!sp.points?.length) return false;
    const c = centroid(sp.points);
    return Math.hypot(c[0] - blobCentroid[0], c[1] - blobCentroid[1]) <= searchRadius;
  });
  const stitched = stitchSegments(nearby, opts.stitchTol ?? 0.001);

  for (const sp of stitched) {
    const line = isLineLike(sp.points, opts);
    if (!line) continue;
    const dx = blobCentroid[0] - line.center[0], dy = blobCentroid[1] - line.center[1];
    const perpDist = Math.abs(-dx * line.dir[1] + dy * line.dir[0]);
    const ratio = line.length / blobDiameter;
    if (perpDist <= centerTol && ratio >= minLenRatio && ratio <= maxLenRatio) return line;
  }
  return null;
}

/**
 * Diagnostic sibling of findLineThroughCenter — every line-like candidate near
 * the blob regardless of whether it would pass the length/center checks,
 * closest-perpendicular-distance first.
 *
 * @returns {Array} [{ perpDist, ratio, length, center, dir }]
 */
export function debugLineCandidates(blobCentroid, blobRadius, strokeSubpaths = [], opts = {}) {
  const searchRadius = opts.searchRadius ?? (blobRadius > 0 ? blobRadius * 6 + 0.02 : 0.02);
  const blobDiameter = blobRadius * 2;
  const nearby = strokeSubpaths.filter((sp) => {
    if (!sp.points?.length) return false;
    const c = centroid(sp.points);
    return Math.hypot(c[0] - blobCentroid[0], c[1] - blobCentroid[1]) <= searchRadius;
  });
  const stitched = stitchSegments(nearby, opts.stitchTol ?? 0.001);
  const out = [];
  for (const sp of stitched) {
    const line = isLineLike(sp.points, opts);
    if (!line) continue;
    const dx = blobCentroid[0] - line.center[0], dy = blobCentroid[1] - line.center[1];
    out.push({
      perpDist: Math.abs(-dx * line.dir[1] + dy * line.dir[0]),
      ratio: blobDiameter > 0 ? line.length / blobDiameter : null,
      length: line.length, center: line.center, dir: line.dir
    });
  }
  return out.sort((a, b) => a.perpDist - b.perpDist);
}

/**
 * Diagnostic sibling of findEncirclingRing — never used in the accept/reject
 * path itself, returns every circle-like candidate near the blob (regardless
 * of whether it would pass the ratio/center checks), closest first, so a
 * rejection can be inspected instead of just returning null. Built for
 * calibrating centerTol/minRadiusRatio/maxRadiusRatio against real page
 * geometry when a blind tolerance guess turns out wrong in production.
 *
 * @returns {Array} [{ dCenter, ratio, center, radius }] sorted by dCenter, closest first
 */
export function debugRingCandidates(blobCentroid, blobRadius, strokeSubpaths = [], opts = {}) {
  const searchRadius = opts.searchRadius ?? (blobRadius > 0 ? blobRadius * 4 + 0.02 : 0.02);
  const nearby = strokeSubpaths.filter((sp) => {
    if (!sp.points?.length) return false;
    const c = centroid(sp.points);
    return Math.hypot(c[0] - blobCentroid[0], c[1] - blobCentroid[1]) <= searchRadius;
  });
  const stitched = stitchSegments(nearby, opts.stitchTol ?? 0.001);
  const out = [];
  for (const sp of stitched) {
    const circle = isCircleLike(sp.points);
    if (!circle) continue;
    out.push({
      dCenter: Math.hypot(circle.center[0] - blobCentroid[0], circle.center[1] - blobCentroid[1]),
      ratio: blobRadius > 0 ? circle.radius / blobRadius : null,
      center: circle.center, radius: circle.radius
    });
  }
  return out.sort((a, b) => a.dCenter - b.dCenter);
}

/**
 * Group filled sub-paths into per-glyph blobs. Sub-paths above `bodyArea` are glyph
 * BODIES; each smaller sub-path (lens cones, mounting marks) attaches to the nearest
 * body by edge distance to the body centroid. Points are assumed already normalized,
 * so `bodyArea` is in normalized-area units (the tool's default 2e-5; the QTS plateau
 * that yields the right 17-camera split spans ~1e-5..2e-5).
 *
 * @param {Array} subpaths [{ points:[[x,y]...](normalized), fill_rgb? }]
 * @param {Object} opts { bodyArea = 2e-5 }
 * @returns {Array} blobs: { fill_rgb, x, y, n_members, paths:[{points,closed,filled}] }
 *          x,y = body centroid (the device's true mount point), in normalized space.
 */
export function groupSubpaths(subpaths = [], opts = {}) {
  const bodyArea = opts.bodyArea ?? 2e-5;
  const subs = subpaths.map((s) => ({ ...s, c: centroid(s.points), area: polyArea(s.points) }));
  const bodies = subs.filter((s) => s.area > bodyArea).map((s) => ({ c: s.c, fill_rgb: s.fill_rgb, members: [s] }));
  if (!bodies.length) return [];
  for (const s of subs) {
    if (s.area > bodyArea) continue;
    let bi = -1, bd = Infinity;
    bodies.forEach((b, k) => {
      const dd = Math.min(...s.points.map(([x, y]) => Math.hypot(x - b.c[0], y - b.c[1])));
      if (dd < bd) { bd = dd; bi = k; }
    });
    if (bi >= 0) bodies[bi].members.push(s);
  }
  return bodies.map((b) => ({
    fill_rgb: b.fill_rgb || null,
    x: parseFloat(b.c[0].toFixed(4)),
    y: parseFloat(b.c[1].toFixed(4)),
    n_members: b.members.length,
    paths: b.members.map((s) => ({ points: s.points, closed: true, filled: true })),
  }));
}

/**
 * Classify ONE camera blob into a lens class. Geometry-first, honest about its edge:
 *   1) if plan-exemplar prototypes are supplied and one matches within tol -> that type;
 *   2) else the validated rule — an elongated body (aspect > aspectHubMax) is a single
 *      directional 1-lens; a compact hub with four evenly-spaced arms is a 4-lens;
 *   3) anything else (3 arms, or an ASYMMETRIC 4) is the documented ambiguous 3-vs-4
 *      hub — returned as 3-lens but FLAGGED 'verify_lens_count' for the ring verifier,
 *      never silently forced. Flagging is half the module (brittleness -> human).
 *
 * The returned `type` is the lens CLASS (1-lens|3-lens|4-lens). Mapping a lens class
 * to the catalog's device-type name is a config/discovery concern (handled upstream),
 * kept out of here so this stays the pure geometric call.
 *
 * @param {Object} blob  { paths:[{points,...}] } (normalized)
 * @param {Object} opts  { prototypes?:[{type,sig}], protoTol=1.4, aspectHubMax=2.2 }
 * @returns {{ type, confidence, flag, via, arms, sig }}
 */
export function classifyCameraBlob(blob, opts = {}) {
  const { prototypes = null, protoTol = 1.4, aspectHubMax = 2.2, lensTokens = null } = opts;
  const sig = computeSignature(blob);
  const arms = countRadialArms(blob);
  // Lens-class rule (validated, prototype-independent): elongated body -> single
  // directional; compact hub with confident four arms -> four-lens; otherwise the
  // documented ambiguous hub (flagged for the ring verifier).
  const ruleLens = sig.aspect > aspectHubMax ? '1-lens'
    : (arms.confident && arms.arms === 4) ? '4-lens' : '3-lens';
  const ruleAmbiguous = ruleLens === '3-lens';

  // If prototypes are supplied, the emitted `type` is the prototype's join TOKEN, not
  // the lens-class string — reconcile joins on it. Build the lens-class -> token map
  // from the prototypes (they carry lens_class); fall back to the lens string if a
  // class has no prototype, so a partially-seeded catalog still degrades sanely.
  const tokenFor = (lens) => {
    if (prototypes) {
      const p = prototypes.find((q) => q.lens_class === lens);
      if (p) return p.type;
    }
    if (lensTokens && lensTokens[lens]) return lensTokens[lens];
    return lens;
  };

  if (prototypes && prototypes.length) {
    const c = classifyBlob(sig, prototypes, protoTol);
    if (c.match === 'matched') {
      // A prototype can NAME a glyph, but must not claim confidence on the known-
      // ambiguous hub call. A compact hub whose arms aren't a confident four is the
      // documented ambiguity: keep the matched token but FLAG it, so the human reviews
      // the same set whether the call came from prototype or rule. Flagging is half the
      // module — a prototype distance under tolerance does not buy past it.
      if (ruleAmbiguous) return { type: c.type, confidence: 'low', flag: 'verify_lens_count', via: 'prototype', arms: arms.arms, score: c.score, sig };
      return { type: c.type, confidence: 'high', flag: null, via: 'prototype', arms: arms.arms, score: c.score, sig };
    }
    // Prototype MISS: fall through to the rule but emit the rule lens-class's token, so
    // an aspect-outlier directional camera that missed its prototype still joins. via
    // records that the rule decided. Ambiguous hubs stay flagged.
    return { type: tokenFor(ruleLens), confidence: ruleAmbiguous ? 'low' : 'high', flag: ruleAmbiguous ? 'verify_lens_count' : null, via: 'rule_fallthrough', arms: arms.arms, sig };
  }

  // No prototypes: emit the rule lens-class mapped through lensTokens (cam_*),
  // falling back to the bare lens-class string when no map is configured.
  return { type: tokenFor(ruleLens), confidence: ruleAmbiguous ? 'low' : 'high', flag: ruleAmbiguous ? 'verify_lens_count' : null, via: 'rule', arms: arms.arms, sig };
}

/**
 * Convenience orchestrator for the LIVE client path and the offline extract gate:
 * extract -> normalize -> fill-filter -> group. Returns blobs + the frame so the
 * caller can place text/demarc in the same space. Classification is left to the
 * caller (classifyCameraBlob) so the same blobs can also feed the ring verifier.
 *
 * @param {Object} page  opened pdf.js page
 * @param {Object} OPS   pdfjsLib.OPS
 * @param {Array}  textCenters [{cx,cy}] user-space text centres (for the frame)
 * @param {Object} opts  { vpW, vpH, fill, fillTol=48, bodyArea=2e-5 }
 * @returns {Promise<{ blobs, frame, n_subpaths_raw, n_subpaths_kept }>}
 */
export async function extractCameraBlobs(page, OPS, textCenters = [], opts = {}) {
  const { vpW = 0, vpH = 0, fill = null, fillTol = 48, bodyArea = 2e-5 } = opts;
  const frame = contentFrame(textCenters, vpW, vpH);
  // One operator-list walk for both — extractSubpaths returns filled AND
  // stroke-only paths tagged; splitting locally avoids parsing the PDF twice.
  const rawAll = await extractSubpaths(page, OPS);
  const raw = rawAll.filter((s) => s.filled);
  const rawStrokes = rawAll.filter((s) => !s.filled);
  const normed = raw.map((s) => ({ ...s, points: s.points.map(([x, y]) => frame.norm(x, y)) }));
  const normedStrokes = rawStrokes.map((s) => ({ ...s, points: s.points.map(([x, y]) => frame.norm(x, y)) }));
  const kept = filterByFill(normed, fill, fillTol);
  const blobs = groupSubpaths(kept, { bodyArea });
  return { blobs, frame, n_subpaths_raw: raw.length, n_subpaths_kept: kept.length, strokeSubpaths: normedStrokes };
}

export default { contentFrame, extractFilledSubpaths, extractSubpaths, filterByFill, groupSubpaths, isCircleLike, stitchSegments, findEncirclingRing, debugRingCandidates, isLineLike, findLineThroughCenter, debugLineCandidates, debugNearbyStrokes, classifyCameraBlob, extractCameraBlobs, polyArea };
