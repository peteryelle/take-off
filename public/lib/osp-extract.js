// public/lib/osp-extract.js
// JavaScript port of extract_conduit.py (the Python OSP conduit extractor
// built and validated on T-108 in the "Fiber conduit distance detection
// methods" work). Pure: takes vector strokes + text words, returns the take-off.
// No network, no LLM. Every stage is checked against the Python's T-108 output.
//
// Coordinates are PyMuPDF's page frame (points, origin top-left, y down), so
// numbers can be compared 1:1 with the Python run. toPageFrame() converts the
// repo's pdf.js strokes (PDF user space, y up) into that frame.
// ─────────────────────────────────────────────────────────────────

// Line classes. Edit if an RFI answer differs (Python: CLASS_OF).
export const CLASS_OF = { new: [1.0, 0.0, 0.0], existing: [0.0, 0.0, 1.0] };
export const STANDARD_SCALES = [10, 16, 20, 30, 40, 50, 60, 80, 100, 200];
export const PULL_LIMIT_OSP_FT = 250;
export const PULL_LIMIT_INTERIOR_FT = 100;
export const MAX_BENDS_DEG = 180;

// ── geometry ─────────────────────────────────────────────────────
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const plen = (pts) => { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]); return s; };
export const unit = (v) => { const n = Math.hypot(v[0], v[1]); return n > 1e-9 ? [v[0] / n, v[1] / n] : [0, 0]; };
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const DEG = 180 / Math.PI;
export const colIs = (c, t, tol = 0.03) => !!c && c.length >= 3 && [0, 1, 2].every((i) => Math.abs(c[i] - t[i]) <= tol);
export const inRect = (p, r) => r[0] <= p[0] && p[0] <= r[2] && r[1] <= p[1] && p[1] <= r[3];
export function segHitsRect(a, b, r, n = 6) {
  for (let k = 0; k <= n; k++) if (inRect([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], r)) return true;
  return false;
}
export function segPoint(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return [dist(p, q), t, q];
}
export function polyNearest(p, pts) {
  let best = [1e18, -1, 0, null];
  for (let i = 0; i < pts.length - 1; i++) { const [d, t, q] = segPoint(p, pts[i], pts[i + 1]); if (d < best[0]) best = [d, i, t, q]; }
  return best;
}
export function pointAt(pts, frac) {
  const target = plen(pts) * frac; let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const s = dist(pts[i], pts[i + 1]);
    if (s > 0 && acc + s >= target) { const t = (target - acc) / s; return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])]; }
    acc += s;
  }
  return pts[pts.length - 1];
}
const turn = (a, b, c) => { const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]]; return Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], dot(v1, v2)) * DEG; };
export function turningDeg(pts, minSeg = 1.5, minTurn = 1.0) {
  const s = [pts[0]];
  for (const p of pts.slice(1)) if (dist(p, s[s.length - 1]) >= minSeg) s.push(p);
  let total = 0;
  for (let i = 1; i < s.length - 1; i++) { const a = Math.abs(turn(s[i - 1], s[i], s[i + 1])); if (a >= minTurn) total += a; }
  return total;
}
// Ramer–Douglas–Peucker (same traversal as the Python, so kept points match).
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop(); let dmax = 0, idx = null;
    for (let i = i0 + 1; i < i1; i++) { const d = segPoint(pts[i], pts[i0], pts[i1])[0]; if (d > dmax) { dmax = d; idx = i; } }
    if (idx !== null && dmax > eps) { keep[idx] = true; stack.push([i0, idx], [idx, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// Bend angles (deg) along a plan-view route — see Python bend_list for the rules.
export function bendList(pts, ppf, eps = 1.5, minTurn = 8.0, sweepFt = 4.0, spikeFt = 6.0) {
  const s = rdp(pts, eps);
  let changed = true;
  while (changed && s.length > 2) {
    changed = false;
    for (let i = 1; i < s.length - 1; i++) {
      const a = Math.abs(turn(s[i - 1], s[i], s[i + 1]));
      const short = Math.min(dist(s[i - 1], s[i]), dist(s[i], s[i + 1])) < spikeFt * ppf;
      if (a > 135 && short) { s.splice(i, 1); changed = true; break; }
    }
  }
  const turns = []; let acc = 0;
  for (let i = 1; i < s.length - 1; i++) { acc += dist(s[i - 1], s[i]); turns.push([acc, turn(s[i - 1], s[i], s[i + 1])]); }
  const bends = []; let group = [], last = null;
  for (const [pos, a] of turns) {
    if (group.length && pos - last > sweepFt * ppf) { bends.push(group.reduce((x, y) => x + y, 0)); group = []; }
    group.push(Math.abs(a)); last = pos;
  }
  if (group.length) bends.push(group.reduce((x, y) => x + y, 0));
  return bends.filter((b) => Math.abs(b) >= minTurn);
}

// Spatial hash (Python: Grid). near() yields in the same cell order.
export class Grid {
  constructor(cell) { this.c = cell; this.g = new Map(); }
  _k(p) { return [Math.floor(p[0] / this.c), Math.floor(p[1] / this.c)]; }
  add(p, item) { const [x, y] = this._k(p); const k = x + ',' + y; if (!this.g.has(k)) this.g.set(k, []); this.g.get(k).push([p, item]); }
  *near(p, r) {
    const [kx, ky] = this._k(p); const n = Math.ceil(r / this.c);
    for (let i = kx - n; i <= kx + n; i++) for (let j = ky - n; j <= ky + n; j++) {
      const cell = this.g.get(i + ',' + j); if (!cell) continue;
      for (const [q, item] of cell) if (dist(p, q) <= r) yield [q, item];
    }
  }
}
export class UF {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  f(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  u(a, b) { this.p[this.f(a)] = this.f(b); }
}

// ── input adapter ────────────────────────────────────────────────
// Repo strokes (geometry.js extractStrokeSubpaths: points in PDF user space,
// stroke_rgb 0–255) -> "draws" in the page frame with colour 0–1.
// view = page.view ([x0, y0, x1, y1]) from pdf.js.
export function toPageFrame(strokes, view) {
  const [x0, , , y1] = view;
  return strokes.map((s) => ({
    color: s.stroke_rgb.map((v) => v / 255),
    width: s.line_width,
    pts: s.points.map(([x, y]) => [x - x0, y1 - y]),
  }));
}

// ── conduit fragments (Python: collect_fragments) ────────────────
const r2 = (v) => Math.round((v || 0) * 100) / 100;
export function collectFragments(draws) {
  const tot = {};
  for (const d of draws) {
    const w = r2(d.width);
    for (const [name, t] of Object.entries(CLASS_OF)) if (colIs(d.color, t)) {
      tot[name] ??= new Map();
      tot[name].set(w, (tot[name].get(w) || 0) + plen(d.pts));
    }
  }
  const widths = {};
  for (const [name, m] of Object.entries(tot)) widths[name] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  const frags = [];
  for (const d of draws) {
    const w = r2(d.width);
    for (const [name, t] of Object.entries(CLASS_OF)) {
      if (name in widths && w === widths[name] && colIs(d.color, t) && plen(d.pts) > 0.1) frags.push({ pts: d.pts, cls: name });
    }
  }
  return { frags, widths };
}

export const endpoint = (fr, e) => (e === 0 ? fr.pts[0] : fr.pts[fr.pts.length - 1]);
export function outward(fr, e) {
  const pts = fr.pts;
  if (e === 0) { for (const q of pts.slice(1)) if (dist(q, pts[0]) > 1e-6) return unit([pts[0][0] - q[0], pts[0][1] - q[1]]); }
  else { const last = pts[pts.length - 1]; for (let i = pts.length - 2; i >= 0; i--) if (dist(pts[i], last) > 1e-6) return unit([last[0] - pts[i][0], last[1] - pts[i][1]]); }
  return [0, 0];
}

export function estimateGap(frags) {
  const g = new Grid(10);
  frags.forEach((fr, i) => { for (const e of [0, 1]) g.add(endpoint(fr, e), [i, e]); });
  const ds = [];
  frags.forEach((fr, i) => {
    for (const e of [0, 1]) {
      const p = endpoint(fr, e);
      const nd = [];
      for (const [q, [j]] of g.near(p, 30)) if (j !== i) { const d = dist(p, q); if (d > 0.3) nd.push(d); }
      if (nd.length) ds.push(Math.min(...nd));
    }
  });
  if (!ds.length) return { median: null, pct: [] };
  ds.sort((a, b) => a - b);
  return { median: ds[Math.floor(ds.length / 2)], pct: [0.1, 0.25, 0.5, 0.75, 0.9].map((k) => Math.round(ds[Math.floor(ds.length * k)] * 100) / 100) };
}

// Pair dash ends across gaps (mutual best match, collinear beyond 1 pt).
export function linkFragments(frags, tol, maxAngle) {
  const cosmax = Math.cos(maxAngle / DEG);
  const g = new Grid(Math.max(tol, 5.0));
  frags.forEach((fr, i) => { for (const e of [0, 1]) g.add(endpoint(fr, e), [i, e]); });
  const best = new Map();
  frags.forEach((fr, i) => {
    for (const e of [0, 1]) {
      const p = endpoint(fr, e), u = outward(fr, e);
      let pick = null;
      for (const [q, [j, f]] of g.near(p, tol)) {
        if (j === i) continue;
        const d = dist(p, q);
        if (d > 1.0) {
          const v = unit([q[0] - p[0], q[1] - p[1]]);
          if (dot(u, v) < cosmax || dot(outward(frags[j], f), [-v[0], -v[1]]) < cosmax) continue;
        }
        // Python: min((d, (j, f))) — ties broken by j, then f.
        if (!pick || d < pick[0] || (d === pick[0] && (j < pick[1] || (j === pick[1] && f < pick[2])))) pick = [d, j, f];
      }
      if (pick) best.set(i + ':' + e, [pick[1], pick[2]]);
    }
  });
  const link = new Map();
  for (const [a, b] of best) { const back = best.get(b[0] + ':' + b[1]); if (back && back[0] + ':' + back[1] === a) link.set(a, b); }
  return link;
}

export function buildChains(frags, link) {
  const seen = new Set(), chains = [];
  for (let s = 0; s < frags.length; s++) {
    if (seen.has(s)) continue;
    let i = s, a = 0, steps = 0;
    for (;;) {
      const pr = link.get(i + ':' + a);
      if (!pr) break;
      i = pr[0]; a = 1 - pr[1]; steps++;
      if (i === s || steps > frags.length) break;
    }
    const pts = [], cls = [];
    while (!seen.has(i)) {
      seen.add(i);
      const fp = a === 0 ? frags[i].pts : frags[i].pts.slice().reverse();
      for (const p of fp) { pts.push(p); cls.push(frags[i].cls); }
      const nx = link.get(i + ':' + (1 - a));
      if (!nx) break;
      [i, a] = nx;
    }
    if (pts.length >= 2) chains.push({ pts, cls });
  }
  return chains;
}

// Bridge tolerance from the measured dash gap (Python: process()).
export const bridgeTolerance = (median, override) => (override ? override : median ? Math.max(2.0, Math.min(14.0, 2.5 * median)) : 6.0);
