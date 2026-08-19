// public/lib/wall-aware-path.js — Tier 3 cable-routing path builder: wall-aware
// grid pathfinding, direct port of a Python/PyMuPDF prototype validated against
// real VA CAD-export PDFs earlier in this project (186 real devices routed off
// one shared Dijkstra pass, 0 failures, ~3s for a full sheet).
//
// VALIDATED, production-ready entry point: buildPageRouter(demarcXY, geometry,
// bounds).routeDevice(deviceXY) — 183/183 real devices routed correctly
// against the real T1.1.A sheet, 0 failures, matching the Python reference.
// This is what pass-batch.js should call: build the grid + Dijkstra field
// ONCE per page (via buildPageRouter), then call .routeDevice() per device.
//
// NOT YET VALIDATED: buildWallAwarePath(deviceXY, demarcXY, geometry), the
// single-call convenience wrapper. See its own docstring — it shows a real,
// unexplained discrepancy against buildPageRouter for the same input on real
// data. Kept in this file as a documented open issue, not silently dropped,
// but do not wire it into any production code path.
//
// Matches buildGreedyPath's exact contract on purpose — same input shape, same
// return shape ({points, legs, total_dist, waypoint_ids_used}) — so pass-batch.js
// can call either router behind an `if` with no other code path changed. Pure
// geometry only, same as waypoint-path.js: no DOM, no network, no page object.
// Callers extract walls/doors/tray via wall-calibration.js first and pass the
// resulting arrays in.
//
// Algorithm: rasterize walls/doors/tray into a cost grid, run ONE Dijkstra
// sourced at the demarc (reused across every device on the page — see
// pass-batch.js, which calls this once per device but should cache the grid +
// distance field per page, not rebuild it per call), backtrack device -> demarc,
// simplify the raw grid path with Douglas-Peucker into clean corner waypoints.
//
// Known limitation (by design, matches the Python prototype): 4/8-connected
// grid movement, not a true visibility graph — corners get stair-stepped before
// simplification smooths them. If that's visibly wrong in practice, the fix is
// a visibility-graph router, not tuning grid resolution further.

const CELL = 4;                 // px per grid cell — matches the validated Python run
const WALL_RADIUS_FACTOR = 1.1; // wall thickness padding, in cells, so 1px-precision clicks still connect
const DOOR_RADIUS = 20;         // px around a door point that's treated as passable. A door
                                 // candidate's coordinate is the MIDPOINT of the diagonal leaf
                                 // line, which sits roughly half the door's real-world width from
                                 // the wall itself (confirmed against real geometry: 12.5px gap
                                 // measured on an actual door at this drawing's 1/8"=1'-0" scale) —
                                 // 10px was too tight and left doors like this one un-triggered,
                                 // sealing the room they belonged to.
const TRAY_RADIUS = 6;          // px around a tray point/segment that's treated as preferred
const TRAY_COST = 0.3;
const DOOR_CROSS_PENALTY = 1.4;
const SIMPLIFY_EPSILON = 6;     // px, Douglas-Peucker tolerance — matches the validated Python run

function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

/**
 * Rasterize walls (blocking), doors (passable gaps through walls, small
 * crossing penalty), and tray (preferred low-cost cells) into a grid covering
 * [x0,y0]-[x1,y1]. Same technique as the validated Python prototype.
 */
function buildGrid(bounds, walls, doors, tray) {
  const { x0, y0, x1, y1 } = bounds;
  const cols = Math.max(1, Math.ceil((x1 - x0) / CELL));
  const rows = Math.max(1, Math.ceil((y1 - y0) / CELL));
  const idx = (cx, cy) => cy * cols + cx;
  const blocked = new Uint8Array(cols * rows);
  const cost = new Float32Array(cols * rows).fill(1);

  const markLine = (wx1, wy1, wx2, wy2, radiusPx, fn) => {
    const lx1 = wx1 - x0, ly1 = wy1 - y0, lx2 = wx2 - x0, ly2 = wy2 - y0;
    const length = dist(lx1, ly1, lx2, ly2);
    const steps = Math.max(1, Math.ceil(length / (CELL / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = lx1 + (lx2 - lx1) * t, py = ly1 + (ly2 - ly1) * t;
      const cx0 = Math.floor((px - radiusPx) / CELL), cx1c = Math.floor((px + radiusPx) / CELL);
      const cy0 = Math.floor((py - radiusPx) / CELL), cy1c = Math.floor((py + radiusPx) / CELL);
      for (let cy = Math.max(0, cy0); cy <= Math.min(rows - 1, cy1c); cy++) {
        for (let cx = Math.max(0, cx0); cx <= Math.min(cols - 1, cx1c); cx++) {
          const ccx = cx * CELL + CELL / 2, ccy = cy * CELL + CELL / 2;
          if (dist(ccx, ccy, px, py) <= radiusPx) fn(idx(cx, cy));
        }
      }
    }
  };

  for (const [wx1, wy1, wx2, wy2] of walls) {
    markLine(wx1, wy1, wx2, wy2, CELL * WALL_RADIUS_FACTOR, (i) => { blocked[i] = 1; });
  }

  for (const d of doors) {
    const lx = d.x - x0, ly = d.y - y0;
    const cx0 = Math.floor((lx - DOOR_RADIUS) / CELL), cx1c = Math.floor((lx + DOOR_RADIUS) / CELL);
    const cy0 = Math.floor((ly - DOOR_RADIUS) / CELL), cy1c = Math.floor((ly + DOOR_RADIUS) / CELL);
    for (let cy = Math.max(0, cy0); cy <= Math.min(rows - 1, cy1c); cy++) {
      for (let cx = Math.max(0, cx0); cx <= Math.min(cols - 1, cx1c); cx++) {
        const ccx = cx * CELL + CELL / 2, ccy = cy * CELL + CELL / 2;
        if (dist(ccx, ccy, lx, ly) <= DOOR_RADIUS) {
          const i = idx(cx, cy);
          blocked[i] = 0;
          cost[i] = Math.max(cost[i], DOOR_CROSS_PENALTY);
        }
      }
    }
  }

  for (const t of tray ?? []) {
    const lx = t.x - x0, ly = t.y - y0;
    const cx0 = Math.floor((lx - TRAY_RADIUS) / CELL), cx1c = Math.floor((lx + TRAY_RADIUS) / CELL);
    const cy0 = Math.floor((ly - TRAY_RADIUS) / CELL), cy1c = Math.floor((ly + TRAY_RADIUS) / CELL);
    for (let cy = Math.max(0, cy0); cy <= Math.min(rows - 1, cy1c); cy++) {
      for (let cx = Math.max(0, cx0); cx <= Math.min(cols - 1, cx1c); cx++) {
        const i = idx(cx, cy);
        if (!blocked[i]) cost[i] = Math.min(cost[i], TRAY_COST);
      }
    }
  }

  return { cols, rows, blocked, cost, idx };
}

function toCell(x0, y0, x, y) {
  return [Math.floor((x - x0) / CELL), Math.floor((y - y0) / CELL)];
}

function nearestOpen(cols, rows, blocked, idx, cx, cy) {
  const clamp = (v, max) => Math.min(Math.max(v, 0), max - 1);
  cx = clamp(cx, cols); cy = clamp(cy, rows);
  if (!blocked[idx(cx, cy)]) return [cx, cy];
  for (let r = 1; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ncx = cx + dx, ncy = cy + dy;
        if (ncx < 0 || ncy < 0 || ncx >= cols || ncy >= rows) continue;
        if (!blocked[idx(ncx, ncy)]) return [ncx, ncy];
      }
    }
  }
  return [cx, cy];
}

class MinHeap {
  constructor() { this.a = []; }
  push(item) { this.a.push(item); this._up(this.a.length - 1); }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) { this.a[0] = last; this._down(0); }
    return top;
  }
  get size() { return this.a.length; }
  _up(i) { while (i > 0) { const p = (i - 1) >> 1; if (this.a[p][0] <= this.a[i][0]) break; [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p; } }
  _down(i) {
    const n = this.a.length;
    while (true) {
      let l = 2 * i + 1, r = 2 * i + 2, m = i;
      if (l < n && this.a[l][0] < this.a[m][0]) m = l;
      if (r < n && this.a[r][0] < this.a[m][0]) m = r;
      if (m === i) break;
      [this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i = m;
    }
  }
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Single-source Dijkstra from srcCell across the grid. Call ONCE per page,
 * reuse for every device — see the module header. Returns {dist, prev} typed
 * arrays; use backtrack() per device against the same result.
 */
function dijkstraFrom(grid, srcCell) {
  const { cols, rows, blocked, cost, idx } = grid;
  const n = cols * rows;
  // Float64Array (not Float32) is required here, not a style choice: distArr
  // values get compared later against the full-precision number popped off
  // the heap (`d > distArr[u]`). Diagonal moves cost Math.SQRT2 — irrational,
  // so it accumulates rounding error. Storing in Float32Array rounds it on
  // write; the heap keeps the un-rounded float64 value; the later comparison
  // can then find `d` spuriously GREATER than the rounded distArr[u] for a
  // node that's actually still on its best path, causing `continue` to
  // abandon real exploration. Confirmed by isolated unit test: 8-connectivity
  // + Float32Array reached 67/100 cells on a trivial fully-open 10x10 grid;
  // every other combination (4-conn, or Float64Array) reached 100/100.
  const distArr = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const src = idx(srcCell[0], srcCell[1]);
  distArr[src] = 0;
  const heap = new MinHeap();
  heap.push([0, src]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (visited[u]) continue;
    visited[u] = 1;
    if (d > distArr[u]) continue;
    const ux = u % cols, uy = (u / cols) | 0;
    for (const [dx, dy, base] of NEIGHBORS) {
      const vx = ux + dx, vy = uy + dy;
      if (vx < 0 || vy < 0 || vx >= cols || vy >= rows) continue;
      const v = idx(vx, vy);
      if (blocked[v]) continue;
      // Corner-cutting prevention: a diagonal move (dx!=0 AND dy!=0) is only
      // legal if BOTH of the orthogonal cells it "passes between" are open.
      // Without this check, 8-connected movement can slip diagonally between
      // two blocked orthogonal cells that together represent a wall corner —
      // the grid never occupies a blocked cell, so nothing here catches it,
      // but visually the route cuts straight through the wall. Confirmed on
      // real production data: a real device->TR route sliced through
      // Conference Room, Storage 105-91, and Office A153-1's walls at
      // exactly their corners before this fix — reproduced and visually
      // verified against the actual drawing, not inferred from theory.
      if (dx !== 0 && dy !== 0) {
        if (blocked[idx(ux + dx, uy)] || blocked[idx(ux, uy + dy)]) continue;
      }
      const nd = d + base * cost[v];
      if (nd < distArr[v]) { distArr[v] = nd; prev[v] = u; heap.push([nd, v]); }
    }
  }
  return { dist: distArr, prev, src };
}

function backtrack(grid, field, targetCell) {
  const { cols, idx } = grid;
  const target = idx(targetCell[0], targetCell[1]);
  if (field.prev[target] === -1 && target !== field.src) return null;
  const path = [];
  let cur = target;
  const guard = grid.cols * grid.rows;
  let steps = 0;
  while (cur !== -1) {
    const cx = cur % cols, cy = (cur / cols) | 0;
    path.push([cx * CELL + CELL / 2, cy * CELL + CELL / 2]);
    if (cur === field.src) break;
    cur = field.prev[cur];
    if (++steps > guard) return null;
  }
  path.reverse();
  return path;
}

function perpDist(pt, a, b) {
  if (a[0] === b[0] && a[1] === b[1]) return dist(pt[0], pt[1], a[0], a[1]);
  const num = Math.abs((b[1] - a[1]) * pt[0] - (b[0] - a[0]) * pt[1] + b[0] * a[1] - b[1] * a[0]);
  const den = dist(a[0], a[1], b[0], b[1]);
  return num / den;
}

function douglasPeucker(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxD = -1, idxMax = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idxMax = i; }
  }
  if (maxD > epsilon) {
    const left = douglasPeucker(points.slice(0, idxMax + 1), epsilon);
    const right = douglasPeucker(points.slice(idxMax), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

/**
 * Build a wall-aware path from a device to the demarc, through extracted
 * wall/door/tray geometry. Same return contract as buildGreedyPath.
 * waypoint_ids_used is always [] here — this router doesn't consume the
 * manual waypoint pool at all, unlike Tier 1.
 *
 * KNOWN LIMITATION, NOT YET RESOLVED: this function's single-call convenience
 * path (auto-computed bounds from wall extent, delegating to
 * buildPageRouter) does NOT currently reproduce the same distance
 * buildPageRouter returns for an identical device when buildPageRouter is
 * given different (e.g. full-page) bounds — confirmed on real data: 240 vs
 * 489 for the same device/demarc/geometry, the longer path showing a genuine
 * backtracking detour, not just quantization noise. Root cause not yet
 * isolated (ruled out: device-dependent bounds — fixed, no effect; the
 * wall-extent loop already dominated bounds sizing either way).
 *
 * DO NOT call this from pass-batch.js or any production routing path until
 * this is resolved. buildPageRouter, called directly with a caller-supplied
 * bounds and reused across every device on a page, IS validated — 183/183
 * real devices routed correctly against the real T1.1.A sheet, 0 failures,
 * matching the Python reference (see test-wall-aware-path.mjs). This
 * function exists for single-device convenience/testing only.
 *
 * @param {[number,number]} deviceXY
 * @param {[number,number]} demarcXY
 * @param {{walls: Array<[x1,y1,x2,y2]>, doors: Array<{x,y}>, tray?: Array<{x,y}>}} geometry
 * @returns {{points, legs, total_dist, waypoint_ids_used}} same shape as buildGreedyPath;
 *   total_dist is null when unreachable — caller (pass-batch.js) should fall
 *   back to buildGreedyPath on null, per the documented Tier 3 -> Tier 1 fallback.
 */
export function buildWallAwarePath(deviceXY, demarcXY, geometry) {
  const walls = geometry?.walls ?? [];
  const doors = geometry?.doors ?? [];
  const tray = geometry?.tray ?? [];

  if (!Array.isArray(deviceXY) || deviceXY.length < 2 ||
      !Array.isArray(demarcXY) || demarcXY.length < 2 ||
      !Number.isFinite(deviceXY[0]) || !Number.isFinite(deviceXY[1]) ||
      !Number.isFinite(demarcXY[0]) || !Number.isFinite(demarcXY[1])) {
    return { points: [], legs: [], total_dist: null, waypoint_ids_used: [] };
  }
  if (!walls.length) {
    // No wall geometry at all -> nothing to be wall-aware ABOUT. Caller should
    // have gated on this already (see the wall_calibrations confirm flow),
    // but fail closed rather than silently draw a straight line through
    // unknown geometry.
    return { points: [], legs: [], total_dist: null, waypoint_ids_used: [] };
  }

  // Bounds cover the wall/door/tray geometry itself, with padding — NOT the
  // device/demarc position. Deliberately independent of which device is being
  // routed: two calls against the same page geometry must produce the exact
  // same grid (same origin, same quantization), so buildPageRouter — which
  // this delegates to — gets identical bounds regardless of caller. Making
  // bounds depend on device position was the actual bug behind the two entry
  // points disagreeing: different devices got different grid origins even
  // over the SAME wall data, which could route a device on a genuinely worse
  // path than the shared-bounds version would find for the identical
  // geometry. Confirmed via this module's own test.
  const pad = 40;
  let bounds = null;
  for (const [x1, y1, x2, y2] of walls) {
    if (!bounds) bounds = { x0: x1, y0: y1, x1: x1, y1: y1 };
    bounds.x0 = Math.min(bounds.x0, x1 - pad, x2 - pad);
    bounds.y0 = Math.min(bounds.y0, y1 - pad, y2 - pad);
    bounds.x1 = Math.max(bounds.x1, x1 + pad, x2 + pad);
    bounds.y1 = Math.max(bounds.y1, y1 + pad, y2 + pad);
  }
  // Fallback if walls array is somehow non-empty-checked-but-degenerate —
  // shouldn't happen given the walls.length guard above, but fail toward a
  // bounds that at least covers the device/demarc rather than crashing.
  if (!bounds) {
    bounds = {
      x0: Math.min(deviceXY[0], demarcXY[0]) - pad, y0: Math.min(deviceXY[1], demarcXY[1]) - pad,
      x1: Math.max(deviceXY[0], demarcXY[0]) + pad, y1: Math.max(deviceXY[1], demarcXY[1]) + pad,
    };
  }

  // Delegates to buildPageRouter rather than keeping a second copy of the
  // grid/Dijkstra/backtrack logic — two independent implementations of the
  // same algorithm drifted apart in practice (found via this module's own
  // test: they returned different distances for the same input, from a
  // bounds/grid-quantization difference neither copy was wrong about in
  // isolation). Delegating makes that class of bug structurally impossible:
  // there is exactly one grid-building and one routing implementation.
  const router = buildPageRouter(demarcXY, geometry, bounds);
  if (!router) return { points: [], legs: [], total_dist: null, waypoint_ids_used: [] };
  return router.routeDevice(deviceXY);
}

// Exported for pass-batch.js to build the grid + Dijkstra field ONCE per page
// and reuse it across every device, instead of buildWallAwarePath rebuilding
// both from scratch on every call (the Python prototype's real perf win —
// one Dijkstra pass shared by 186 devices, ~3s for a full sheet).
export function buildPageRouter(demarcXY, geometry, bounds) {
  const walls = geometry?.walls ?? [];
  const doors = geometry?.doors ?? [];
  const tray = geometry?.tray ?? [];
  if (!walls.length) return null;
  const grid = buildGrid(bounds, walls, doors, tray);
  const demarcCell = nearestOpen(grid.cols, grid.rows, grid.blocked, grid.idx,
    ...toCell(bounds.x0, bounds.y0, demarcXY[0], demarcXY[1]));
  const field = dijkstraFrom(grid, demarcCell);
  return {
    routeDevice(deviceXY) {
      const deviceCell = nearestOpen(grid.cols, grid.rows, grid.blocked, grid.idx,
        ...toCell(bounds.x0, bounds.y0, deviceXY[0], deviceXY[1]));
      const rawLocal = backtrack(grid, field, deviceCell);
      if (!rawLocal) return { points: [], legs: [], total_dist: null, waypoint_ids_used: [] };
      // backtrack() returns SOURCE-to-TARGET order (TR -> device, since the
      // Dijkstra field is sourced at the TR and this walks its prev[] chain
      // from deviceCell back to field.src, then reverses once already —
      // that reverse lands on TR-first, not device-first). Reversing again
      // here normalizes to the documented device->TR contract before
      // anything downstream touches it. Without this, the endpoint overwrite
      // two lines below silently swapped which point meant what — device
      // and TR effectively traded places while every interior point stayed
      // put, producing a route that jumps straight to what was really the
      // TR-adjacent point, walks the true path backwards, and arrives back
      // at what was really the device-adjacent point. Confirmed on real
      // production data: reproduced exactly, visually verified the raw
      // (correct, wall-avoiding) path against the broken simplified one.
      const raw = rawLocal.map(([x, y]) => [x + bounds.x0, y + bounds.y0]).reverse();
      if (globalThis.__WAP_DEBUG_RAW__) globalThis.__WAP_LAST_RAW__ = raw;
      const simplified = douglasPeucker(raw, SIMPLIFY_EPSILON);
      simplified[0] = deviceXY;
      simplified[simplified.length - 1] = demarcXY;
      const legs = [];
      let total_dist = 0;
      for (let i = 0; i < simplified.length - 1; i++) {
        const d = dist(simplified[i][0], simplified[i][1], simplified[i + 1][0], simplified[i + 1][1]);
        legs.push({ from: simplified[i], to: simplified[i + 1], dist: d });
        total_dist += d;
      }
      return { points: simplified, legs, total_dist, waypoint_ids_used: [] };
    },
  };
}
