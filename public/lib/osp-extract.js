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

// ═════════════════════════════ stage 2 ═════════════════════════════
export const BLACK = [0, 0, 0];

// Python round(): exact halves go to the even neighbour.
export function pyRound(x, nd = 0) {
  const f = 10 ** nd, y = x * f, fl = Math.floor(y);
  if (y - fl === 0.5) return (fl % 2 === 0 ? fl : fl + 1) / f;
  return Number(x.toFixed(nd));
}

// ── drawing reader that keeps PyMuPDF's item kinds ──
// Each draw: { color [0..1], width, items: [['l',a,b] | ['c',p0,p1,p2,p3] | ['re',[x0,y0,x1,y1]]] }
// in the page frame (top-left origin). Curves stay curves (the MH/HH square
// finder ignores them, as the Python does); closePath adds no line item.
export async function extractDraws(page, OPS) {
  const [vx0, , , vy1] = page.view;
  const { fnArray, argsArray } = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0], stroke = [0, 0, 0], lw = 1;
  const stack = [], out = [];
  let items = [], pt = null, start = null;
  const T = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4] - vx0, vy1 - (ctm[1] * x + ctm[3] * y + ctm[5])];
  const scale = () => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  const cmyk = ([c, m, y, k]) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push([ctm.slice(), stroke.slice(), lw]); break;
      case OPS.restore: if (stack.length) [ctm, stroke, lw] = stack.pop(); break;
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.setStrokeRGBColor: stroke = [a[0] / 255, a[1] / 255, a[2] / 255]; break;
      case OPS.setStrokeGray: stroke = [a[0], a[0], a[0]]; break;
      case OPS.setStrokeCMYKColor: stroke = cmyk(a); break;
      case OPS.setLineWidth: lw = a[0]; break;
      case OPS.constructPath: {
        const ops = a[0], co = a[1]; let j = 0;
        for (const op of ops) {
          if (op === OPS.moveTo) { pt = T(co[j++], co[j++]); start = pt; }
          else if (op === OPS.lineTo) { const p = T(co[j++], co[j++]); if (pt) items.push(['l', pt, p]); pt = p; }
          else if (op === OPS.curveTo) { const c1 = T(co[j++], co[j++]), c2 = T(co[j++], co[j++]), e = T(co[j++], co[j++]); if (pt) items.push(['c', pt, c1, c2, e]); pt = e; }
          else if (op === OPS.curveTo2) { const c2 = T(co[j++], co[j++]), e = T(co[j++], co[j++]); if (pt) items.push(['c', pt, pt, c2, e]); pt = e; }
          else if (op === OPS.curveTo3) { const c1 = T(co[j++], co[j++]), e = T(co[j++], co[j++]); if (pt) items.push(['c', pt, c1, e, e]); pt = e; }
          else if (op === OPS.rectangle) {
            const x = co[j++], y = co[j++], w = co[j++], h = co[j++];
            const c = [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)];
            const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
            items.push(['re', [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]]);
            pt = c[0]; start = c[0];
          } else if (op === OPS.closePath) { pt = start; }
        }
        break;
      }
      case OPS.stroke: case OPS.closeStroke: case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
        if (items.length) out.push({ color: stroke.slice(), width: lw * scale(), items });
        items = []; pt = null; break;
      case OPS.fill: case OPS.eoFill: case OPS.endPath: items = []; pt = null; break;
    }
  }
  return out;
}

export function bezier(p0, p1, p2, p3, n = 8) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, m = 1 - t;
    out.push([m ** 3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0], m ** 3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1]]);
  }
  return out;
}
// Continuous point lists of one draw (Python: subpaths).
export function subpaths(d) {
  const out = []; let cur = [];
  for (const it of d.items) {
    let seg;
    if (it[0] === 'l') seg = [it[1], it[2]];
    else if (it[0] === 'c') seg = bezier(it[1], it[2], it[3], it[4]);
    else if (it[0] === 're') { const r = it[1]; seg = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [r[0], r[1]]]; }
    else continue;
    if (cur.length && dist(cur[cur.length - 1], seg[0]) < 0.05) cur.push(...seg.slice(1));
    else { if (cur.length >= 2) out.push(cur); cur = seg.slice(); }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}
// Fragments from draws with items (replaces the stroke-list path of stage 1).
export function collectFragmentsFromDraws(draws) {
  const tot = {};
  for (const d of draws) {
    const w = r2(d.width);
    for (const [name, t] of Object.entries(CLASS_OF)) if (colIs(d.color, t)) {
      tot[name] ??= new Map();
      tot[name].set(w, (tot[name].get(w) || 0) + subpaths(d).reduce((a, s) => a + plen(s), 0));
    }
  }
  const widths = {};
  for (const [name, m] of Object.entries(tot)) widths[name] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  const frags = [];
  for (const d of draws) {
    const w = r2(d.width);
    for (const [name, t] of Object.entries(CLASS_OF)) {
      if (name in widths && w === widths[name] && colIs(d.color, t)) for (const s of subpaths(d)) if (plen(s) > 0.1) frags.push({ pts: s, cls: name });
    }
  }
  return { frags, widths };
}

// ── text: PyMuPDF-style words, lines and blocks from pdf.js text runs ──
// PyMuPDF line boxes run 0.697 x font size above the baseline and 0.197
// below (measured on T-108 against page.get_text("dict")); pdf.js's own font
// ascent (0.905) gives taller boxes, so the measured proportions are used.
export const ASC = 0.697, DESC = 0.197;

function runsOf(tcItems, view) {
  const [vx0, , , vy1] = view;
  const out = [];
  for (const it of tcItems) {
    if (!it.str) continue;
    const size = Math.hypot(it.transform[2], it.transform[3]);
    const x = it.transform[4] - vx0, base = vy1 - it.transform[5];
    out.push({ str: it.str, x0: x, x1: x + it.width, base, size, cw: it.width / Math.max(it.str.length, 1) });
  }
  return out;
}

export function wordsFromText(tcItems, view) {
  const words = [];
  for (const r of runsOf(tcItems, view)) {
    const re = /\S+/g; let m;
    while ((m = re.exec(r.str))) words.push([r.x0 + m.index * r.cw, r.base - ASC * r.size, r.x0 + (m.index + m[0].length) * r.cw, r.base + DESC * r.size, m[0]]);
  }
  return words;
}

// Blocks of lines (Python: page.get_text("dict")). Runs are taken in the order
// they appear in the PDF: a run continues the current line when it sits on the
// same baseline just to the right; it starts the next line of the same block
// when it sits one line below, left-aligned; otherwise it starts a new block.
// Runs on one line are joined with no separator (as PyMuPDF joins spans),
// unless there is a visible gap between them.
export function textDict(tcItems, view) {
  const blocks = [];
  let blk = null, ln = null;
  for (const r of runsOf(tcItems, view)) {
    if (!r.str.trim() && r.x1 - r.x0 < 0.01) continue; // empty line markers
    const sameLine = ln && Math.abs(r.base - ln.base) < 0.3 * r.size && r.x0 >= ln.x1 - 1 && r.x0 - ln.x1 < 1.5 * r.size;
    const nextLine = blk && !sameLine && r.base - ln.base > 0.3 * r.size && r.base - ln.base < 1.6 * r.size && Math.abs(r.x0 - blk.lines[0].bbox[0]) < 2 * r.size && Math.abs(r.size - ln.size) < 0.5;
    if (sameLine) {
      ln.text += (r.x0 - ln.x1 > 0.25 * r.size ? ' ' : '') + r.str;
      ln.x1 = Math.max(ln.x1, r.x1);
      ln.bbox[2] = Math.max(ln.bbox[2], r.x1);
      continue;
    }
    if (!r.str.trim()) continue; // a lone space does not start a line
    ln = { text: r.str, base: r.base, size: r.size, x1: r.x1, bbox: [r.x0, r.base - ASC * r.size, r.x1, r.base + DESC * r.size] };
    if (nextLine) blk.lines.push(ln);
    else { blk = { lines: [ln] }; blocks.push(blk); }
  }
  for (const b of blocks) {
    b.bbox = [Math.min(...b.lines.map((l) => l.bbox[0])), Math.min(...b.lines.map((l) => l.bbox[1])), Math.max(...b.lines.map((l) => l.bbox[2])), Math.max(...b.lines.map((l) => l.bbox[3]))];
  }
  return blocks;
}

// Blocks as [x0, y0, x1, y1, text] (Python: page.get_text("blocks")).
export function blocksFromText(tcItems, view) {
  return textDict(tcItems, view).map((b) => [...b.bbox, b.lines.map((l) => l.text).join('\n')]);
}

// ── scale bar (Python: detect_scale) ──
export function detectScale(words, W, H) {
  const toks = words.filter((w) => (/^\d+'$/.test(w[4]) || w[4] === '0') && w[0] > W * 0.70 && w[1] > H * 0.75);
  let best = null;
  for (const z of toks.filter((w) => w[4] === '0')) {
    const zx = (z[0] + z[2]) / 2, zy = (z[1] + z[3]) / 2;
    const row = toks.filter((w) => w[4] !== '0' && Math.abs((w[1] + w[3]) / 2 - zy) < 3 && (w[0] + w[2]) / 2 > zx);
    if (row.length) {
      const far = row.reduce((m, w) => ((w[0] + w[2]) / 2 > (m[0] + m[2]) / 2 ? w : m));
      const dx = (far[0] + far[2]) / 2 - zx;
      if (dx > 0) best = parseInt(far[4].slice(0, -1), 10) * 72.0 / dx;
    }
  }
  if (best === null) return { est: null, scale: null };
  return { est: best, scale: STANDARD_SCALES.reduce((m, s) => (Math.abs(s - best) < Math.abs(m - best) ? s : m)) };
}

// ── MH / HH symbol squares (Python: find_boxes) ──
export function findBoxes(draws, labelPts) {
  const near = (p) => labelPts.some((lp) => dist(p, lp) < 40);
  const segs = [], rects = [];
  for (const d of draws) {
    if (!colIs(d.color, BLACK) || !d.width) continue;
    for (const it of d.items) {
      if (it[0] === 're') { const r = it[1]; if (near([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2])) rects.push(r.slice()); }
      else if (it[0] === 'l') { const a = it[1], b = it[2]; if (dist(a, b) < 60 && (near(a) || near(b))) segs.push([a, b]); }
    }
  }
  const uf = new UF(segs.length);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    let m = Infinity; for (const p of segs[i]) for (const q of segs[j]) m = Math.min(m, dist(p, q));
    if (m < 2.0) uf.u(i, j);
  }
  const groups = new Map();
  segs.forEach((s, i) => { const k = uf.f(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
  for (const g of groups.values()) if (g.length >= 3) {
    const xs = g.flatMap((s) => s.map((p) => p[0])), ys = g.flatMap((s) => s.map((p) => p[1]));
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  for (const [x, y] of labelPts) {
    let top = null, bot = null, left = null, right = null;
    for (const [a, b] of segs) {
      if (Math.abs(a[1] - b[1]) < 0.6 && Math.min(a[0], b[0]) - 1 <= x && x <= Math.max(a[0], b[0]) + 1) {
        const yy = (a[1] + b[1]) / 2;
        if (y - yy > 2 && y - yy < 30 && (top === null || yy > top)) top = yy;
        if (yy - y > 2 && yy - y < 30 && (bot === null || yy < bot)) bot = yy;
      } else if (Math.abs(a[0] - b[0]) < 0.6 && Math.min(a[1], b[1]) - 1 <= y && y <= Math.max(a[1], b[1]) + 1) {
        const xx = (a[0] + b[0]) / 2;
        if (x - xx > 2 && x - xx < 40 && (left === null || xx > left)) left = xx;
        if (xx - x > 2 && xx - x < 40 && (right === null || xx < right)) right = xx;
      }
    }
    if (top !== null && bot !== null && left !== null && right !== null) rects.push([left, top, right, bot]);
  }
  return rects.filter((r) => { const w = r[2] - r[0], h = r[3] - r[1]; return w >= 6 && w <= 60 && h >= 6 && h <= 60 && w / h >= 0.6 && w / h <= 1.67; });
}

export function buildZones(words, draws, tol) {
  const labels = words.filter((w) => w[4] === 'MH' || w[4] === 'HH').map((w) => [w[4], [(w[0] + w[2]) / 2, (w[1] + w[3]) / 2]]);
  const boxes = findBoxes(draws, labels.map((l) => l[1]));
  const order = labels.map((l, i) => [i, l]).sort((a, b) => a[1][1][1] - b[1][1][1] || a[1][1][0] - b[1][1][0]);
  const zones = [];
  for (const [, [kind, lp]] of order) {
    const around = boxes.filter((b) => b[0] - 1 <= lp[0] && lp[0] <= b[2] + 1 && b[1] - 1 <= lp[1] && lp[1] <= b[3] + 1);
    let core, src;
    if (around.length) { const b = around.reduce((m, r) => ((r[2] - r[0]) * (r[3] - r[1]) < (m[2] - m[0]) * (m[3] - m[1]) ? r : m)); core = b.slice(); src = 'symbol'; }
    else { core = [lp[0] - 8, lp[1] - 8, lp[0] + 8, lp[1] + 8]; src = 'label-only'; }
    zones.push({ kind, core, src, rect: [core[0] - tol, core[1] - tol, core[2] + tol, core[3] + tol] });
  }
  const counts = {};
  for (const z of zones) { counts[z.kind] = (counts[z.kind] || 0) + 1; z.id = `to${z.kind}-${counts[z.kind]}`; }
  return { zones, nbox: boxes.length };
}

export function splitByZones(chain, zones) {
  const runs = []; let cur = [], curc = [], start = null, prev = null;
  chain.pts.forEach((p, idx) => {
    const c = chain.cls[idx];
    let z = zones.find((zz) => inRect(p, zz.rect))?.id ?? null;
    if (z === null && prev !== null && cur.length) {
      const zb = zones.find((zz) => segHitsRect(prev, p, zz.rect))?.id ?? null;
      if (zb) { if (cur.length >= 2) runs.push({ pts: cur, cls: curc, a: start, b: zb }); cur = []; curc = []; start = zb; }
    }
    if (z !== null) { if (cur.length >= 2) runs.push({ pts: cur, cls: curc, a: start, b: z }); cur = []; curc = []; start = z; }
    else { cur.push(p); curc.push(c); }
    prev = p;
  });
  if (cur.length >= 2) runs.push({ pts: cur, cls: curc, a: start, b: null });
  return runs;
}
export function revEdge(e) {
  const cls = e.cls, rc = [cls[cls.length - 1]];
  for (let k = 1; k < cls.length; k++) rc.push(cls[cls.length - k]);
  return { pts: e.pts.slice().reverse(), cls: rc, a: e.b, b: e.a };
}
export function splitEdge(e, splits) {
  const pts = e.pts, cls = e.cls;
  const sp = splits.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const pieces = []; let cur = [pts[0]], curc = [cls[0]], a = e.a, k = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    while (k < sp.length && sp[k][0] === i) {
      const [, , q, nid] = sp[k];
      cur.push(q); curc.push(cls[i + 1]); pieces.push({ pts: cur, cls: curc, a, b: nid });
      cur = [q]; curc = [cls[i + 1]]; a = nid; k++;
    }
    cur.push(pts[i + 1]); curc.push(cls[i + 1]);
  }
  pieces.push({ pts: cur, cls: curc, a, b: e.b });
  return pieces.filter((p) => p.pts.length >= 2 && plen(p.pts) > 0.5);
}

// ── the route graph: nodes + vault-to-vault segments (Python: process, part 1) ──
// Parity with the Python on T-108: all 29 segments identical (ends, lengths,
// bends) and all 29 nodes identical in type, degree and position.
// One deliberate difference: END notes read "REFER TO SHEET" text that wraps
// across lines. PyMuPDF keeps a trailing space before the line break, so the
// Python's regex missed "...REFER\nTO SHEET T1.B" and tagged toEND-16 with the
// next-nearest sheet (T1.1.B). This port reads the wrapped callout (T1.B).
export function buildGraph({ chains, zones, tol, ppf, blocks }) {
  const nodes = new Map();
  for (const z of zones) {
    const c = z.core;
    nodes.set(z.id, { id: z.id, type: z.kind, x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2, note: `${z.src} tag ${(c[2] - c[0]).toFixed(0)}x${(c[3] - c[1]).toFixed(0)} pt (not to scale)` });
  }
  let edges = [];
  for (const ch of chains) edges.push(...splitByZones(ch, zones));

  // free ends joined end-to-end -> JOINT nodes
  const free = [];
  edges.forEach((e, ei) => { for (const s of ['a', 'b']) if (e[s] === null) free.push([ei, s]); });
  const fpos = free.map(([ei, s]) => (s === 'a' ? edges[ei].pts[0] : edges[ei].pts[edges[ei].pts.length - 1]));
  const uf = new UF(free.length);
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) if (dist(fpos[i], fpos[j]) <= 2 * tol) uf.u(i, j);
  const groups = new Map();
  for (let i = 0; i < free.length; i++) { const k = uf.f(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  let jn = 0; const singles = [];
  for (const g of groups.values()) {
    if (g.length === 1) { singles.push(g[0]); continue; }
    jn++; const nid = `toJ-${jn}`;
    nodes.set(nid, { id: nid, type: 'JOINT', x: g.reduce((a, i) => a + fpos[i][0], 0) / g.length, y: g.reduce((a, i) => a + fpos[i][1], 0) / g.length, note: '' });
    for (const i of g) { const [ei, s] = free[i]; edges[ei][s] = nid; }
  }
  // tee junctions: a free end landing on another run's body
  const splits = new Map();
  for (const i of singles) {
    const [ei, s] = free[i], p = fpos[i];
    let best = null;
    edges.forEach((e, ej) => {
      if (ej === ei) return;
      const [d, si, t, q] = polyNearest(p, e.pts);
      if (d <= 2 * tol + 2 && (best === null || d < best[0])) best = [d, ej, si, t, q];
    });
    if (best) {
      const [, ej, si, t, q] = best;
      jn++; const nid = `toJ-${jn}`;
      nodes.set(nid, { id: nid, type: 'JUNCTION', x: q[0], y: q[1], note: 'tee' });
      edges[ei][s] = nid;
      if (!splits.has(ej)) splits.set(ej, []);
      splits.get(ej).push([si, t, q, nid]);
    }
  }
  edges = edges.flatMap((e, ej) => (splits.has(ej) ? splitEdge(e, splits.get(ej)) : [e]));

  // remaining open ends -> END nodes, tagged with the nearest "REFER TO SHEET"
  const refers = [];
  for (const b of blocks) { const m = String(b[4]).toUpperCase().replace(/\n/g, ' ').match(/REFER TO SHEET\s+([A-Z0-9.\-]+)/); if (m) refers.push([m[1].replace(/\.+$/, ''), b.slice(0, 4)]); }
  let en = 0;
  for (const e of edges) for (const s of ['a', 'b']) if (e[s] === null) {
    const p = s === 'a' ? e.pts[0] : e.pts[e.pts.length - 1];
    let tag = '', bestd = 250;
    for (const [sheet, r] of refers) { const d = dist(p, [Math.min(Math.max(p[0], r[0]), r[2]), Math.min(Math.max(p[1], r[1]), r[3])]); if (d < bestd) { bestd = d; tag = sheet; } }
    en++; const nid = `toEND-${en}`;
    nodes.set(nid, { id: nid, type: 'END', x: p[0], y: p[1], note: tag ? `near 'REFER TO ${tag}'` : '' });
    e[s] = nid;
  }
  // merge straight-through JOINTs (degree 2)
  let changed = true;
  while (changed) {
    changed = false;
    const deg = new Map();
    edges.forEach((e, idx) => { if (e) { for (const s of ['a', 'b']) { if (!deg.has(e[s])) deg.set(e[s], []); deg.get(e[s]).push([idx, s]); } } });
    for (const [nid, lst] of deg) {
      if (nodes.get(nid).type !== 'JOINT' || lst.length !== 2 || lst[0][0] === lst[1][0]) continue;
      const [[i1, s1], [i2, s2]] = lst;
      const e1 = s1 === 'a' ? revEdge(edges[i1]) : edges[i1];
      const e2 = s2 === 'b' ? revEdge(edges[i2]) : edges[i2];
      edges[i1] = { pts: e1.pts.concat(e2.pts), cls: e1.cls.concat(e2.cls), a: e1.a, b: e2.b };
      edges[i2] = null; nodes.get(nid).type = '_merged'; changed = true; break;
    }
  }
  edges = edges.filter((e) => e && plen(e.pts) / ppf >= 1.0);
  const deg = new Map();
  for (const e of edges) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
  for (const [k, v] of [...nodes]) if (v.type === '_merged' || !deg.get(k)) nodes.delete(k);
  for (const [k, v] of nodes) { v.degree = deg.get(k); if (v.type === 'JOINT') v.type = deg.get(k) >= 3 ? 'JUNCTION' : 'BEND'; }

  // run each segment into the MH/HH centre (the part hidden under the tag)
  for (const e of edges) e.bend_pts = e.pts.slice();
  for (const e of edges) {
    const na = nodes.get(e.a), nb = nodes.get(e.b);
    if (na.type === 'MH' || na.type === 'HH') { e.pts = [[na.x, na.y], ...e.pts]; e.cls = [e.cls[0], ...e.cls]; }
    if (nb.type === 'MH' || nb.type === 'HH') { e.pts = [...e.pts, [nb.x, nb.y]]; e.cls = [...e.cls, e.cls[e.cls.length - 1]]; }
  }
  // metrics + ids
  for (const e of edges) {
    let nw = 0, ex = 0;
    for (let i = 0; i < e.pts.length - 1; i++) { const L = dist(e.pts[i], e.pts[i + 1]); if (e.cls[i + 1] === 'new') nw += L; else ex += L; }
    e.new_ft = nw / ppf; e.exist_ft = ex / ppf; e.total_ft = e.new_ft + e.exist_ft;
    e.bend_list = bendList(e.bend_pts, ppf);
    e.bends = e.bend_list.reduce((a, b) => a + Math.abs(b), 0);
    e.mid = pointAt(e.pts, 0.5);
    e.callouts = [];
  }
  edges.sort((a, b) => pyRound(a.mid[1] / 50) - pyRound(b.mid[1] / 50) || a.mid[0] - b.mid[0]);
  edges.forEach((e, i) => { e.id = `toS${String(i + 1).padStart(2, '0')}`; });
  return { nodes, edges };
}

// ═════════════════════════════ stage 3 ═════════════════════════════
export const FILL_12OS2 = 24, FILL_24OS2 = 27; // T-001 fill charts, 4" conduit @ 40%

// Callouts start with "(n) CORE-A/B"; following lines of the same block are
// appended (Python: extract_callouts).
export function extractCallouts(dictBlocks) {
  const out = [];
  for (const b of dictBlocks) {
    let cur = null;
    for (const ln of b.lines) {
      const t = ln.text.trim();
      if (!t) continue;
      if (/^\(\s*\d+\s*\)\s*CORE-[AB]/.test(t.toUpperCase())) {
        if (cur) out.push(cur);
        cur = { text: t, bbox: ln.bbox.slice(), first: ln.bbox.slice(), last: ln.bbox.slice() };
      } else if (cur) {
        cur.text += ' ' + t; cur.last = ln.bbox.slice();
        const bb = ln.bbox, cb = cur.bbox;
        cur.bbox = [Math.min(cb[0], bb[0]), Math.min(cb[1], bb[1]), Math.max(cb[2], bb[2]), Math.max(cb[3], bb[3])];
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function parseCallout(text) {
  const T = text.toUpperCase().replace(/\u201d/g, '"').replace(/\u2033/g, '"').replace(/''/g, '"').split(/\s+/).filter(Boolean).join(' ');
  const r = { raw: T };
  const m = T.match(/^\(\s*(\d+)\s*\)\s*CORE-([AB])/);
  r.cables = parseInt(m[1], 10); r.core = m[2];
  r.demarc = T.includes('DEMARC');
  const grab = (re, dflt = 0) => { const mm = T.match(re); return mm ? parseInt(mm[1], 10) : dflt; };
  r.n4 = grab(/\((\d+)\)\s*4\s*"\s*CONDUITS?/);
  r.n1_fa = grab(/\((\d+)\)\s*1\s*"\s*CONDUITS?\s*FOR\s*FIRE/);
  r.with_cables = grab(/\((\d+)\)\s*CONDUITS?\s*WITH\s*CABLES/, r.n4 === 1 ? 1 : 0);
  r.spare = grab(/\((\d+)\)\s*SPARE/);
  r.elec = grab(/\((\d+)\)\s*CONDUITS?\s*WITH\s*ELECTRICAL/);
  r.pathway = T.includes('PIPE BASEMENT') ? 'pipe basement' : T.includes('EXISTING TUNNEL') ? 'existing tunnel'
    : T.includes('EXISTING UNDERGROUND CONDUIT') ? 'existing UG conduit' : 'duct bank';
  const flags = [];
  if (r.with_cables) {
    const per = r.cables / r.with_cables;
    r.cables_per_conduit = pyRound(per, 1);
    if (per > FILL_24OS2) flags.push(`>${FILL_24OS2}/conduit exceeds 24-str OS2 fill`);
    else if (per > FILL_12OS2) flags.push(`>${FILL_12OS2}/conduit exceeds 12-str OS2 fill`);
  } else r.cables_per_conduit = '';
  if (r.demarc) flags.push('+demarc qty not stated');
  r.fill_flag = flags.join('; ');
  return r;
}

// Thin black strokes: the leader lines (Python: leader_candidates).
export function leaderCandidates(draws) {
  const out = [];
  for (const d of draws) {
    const w = d.width || 0;
    if (colIs(d.color, BLACK) && w >= 0.05 && w <= 1.0) for (const sp of subpaths(d)) { const L = plen(sp); if (L >= 0.5 && L <= 900) out.push(sp); }
  }
  const g = new Grid(5.0);
  out.forEach((sp, i) => { g.add(sp[0], [i, 0]); g.add(sp[sp.length - 1], [i, 1]); });
  return { leaders: out, lgrid: g };
}

// Follow the leader from the callout text to the conduit (Python: trace_leader).
export function traceLeader(co, leaders, lgrid, edges, zones = [], maxHops = 4, hitTol = 8.0) {
  const starts = new Map();
  for (const key of ['first', 'last']) {
    const ln = co[key], ym = (ln[1] + ln[3]) / 2;
    for (const ax of [[ln[0], ym], [ln[2], ym]]) for (const [q, [i, e]] of lgrid.near(ax, 14)) if (Math.abs(q[1] - ym) <= 6) starts.set(i + ':' + e, [i, e]);
  }
  let best = null; const tips = [];
  for (const [i, e] of starts.values()) {
    const path = (e === 0 ? leaders[i] : leaders[i].slice().reverse()).slice(); const used = new Set([i]);
    for (let hop = 0; hop <= maxHops; hop++) {
      const tip = path[path.length - 1]; tips.push(tip);
      for (const ed of edges) { const [d, , , q] = polyNearest(tip, ed.pts); if (d <= hitTol && (best === null || d < best[0])) best = [d, ed, q]; }
      let nxt = null;
      for (const [, [j, f]] of lgrid.near(tip, 0.8)) if (!used.has(j)) { nxt = [j, f]; break; }
      if (nxt === null) break;
      const [j, f] = nxt; used.add(j);
      path.push(...(f === 0 ? leaders[j] : leaders[j].slice().reverse()).slice(1));
    }
  }
  if (best === null) {
    for (const tip of tips) for (const z of zones) {
      const c = z.core;
      if (inRect(tip, [c[0] - 4, c[1] - 4, c[2] + 4, c[3] + 4])) for (const ed of edges) if (ed.a === z.id || ed.b === z.id) {
        const [d, , , q] = polyNearest(tip, ed.pts); if (best === null || d < best[0]) best = [d, ed, q];
      }
    }
  }
  return best;
}

// Attach every callout to a segment: by leader, else nearest (flagged).
export function assignCallouts({ dictBlocks, draws, edges, zones, ppf }) {
  const callouts = extractCallouts(dictBlocks);
  callouts.sort((a, b) => pyRound(a.bbox[1] / 20) - pyRound(b.bbox[1] / 20) || a.bbox[0] - b.bbox[0]);
  const { leaders, lgrid } = leaderCandidates(draws);
  callouts.forEach((co, ci) => {
    co.id = `toC${String(ci + 1).padStart(2, '0')}`;
    Object.assign(co, parseCallout(co.text));
    const best = traceLeader(co, leaders, lgrid, edges, zones);
    if (best) { co.method = 'leader'; co.seg = best[1]; co.hit = best[2]; }
    else {
      const bb = co.bbox, c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
      let pick = null;
      for (const e of edges) { const pn = polyNearest(c, e.pts); if (!pick || pn[0] < pick[0]) pick = [pn[0], e, pn[3]]; }
      co.method = `NEAREST ONLY (${pyRound(pick[0] / ppf)} ft) - verify`; co.seg = pick[1]; co.hit = pick[2];
    }
    co.seg.callouts.push(co);
  });
  return callouts;
}
