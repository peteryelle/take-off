// leader-trace.js
// Pure, offline-testable. Given vector line segments and a label's text anchor,
// recover the leader fan: the shared origin near the anchor and one endpoint
// per leader. Endpoints are the true device locations for a leadered label.
//
// Unit-agnostic: `segments` and `anchor` share one coordinate space (PDF points,
// PDF.js user units, pixels — whatever the caller uses); results come back in
// the same space. The caller normalizes and writes instances.
//
// segments: Array<[[x1,y1],[x2,y2]]>
// anchor:   [x,y]  (the text-anchor location the label detector already has)
//
// Returns:
//   { ok:true,  origin:[x,y], endpoints:[[x,y]...], fanout:N }
//   { ok:false, reason, origin:null, endpoints:[] }   // caller flags for human

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const segLen = (s) => Math.hypot(s[0][0] - s[1][0], s[0][1] - s[1][1]);

export function traceLeaderFan(segments, anchor, opts = {}) {
  const {
    searchRadius = 200, // how far from the anchor the fan origin may sit
    minLeaderLen = 25,  // drops hatch / text / glyph noise (load-bearing)
    snap = 3,           // vertex quantization for origin detection
    minFanout = 3,      // fewer shared long segments than this => not a fan
    dedupeWithin = 6,   // merge endpoints closer than this (same arrowhead)
  } = opts;

  const r2 = searchRadius * searchRadius;

  // Long segments with at least one endpoint near the anchor.
  const longNear = segments.filter(
    (s) =>
      segLen(s) > minLeaderLen &&
      (dist2(s[0], anchor) < r2 || dist2(s[1], anchor) < r2)
  );
  if (longNear.length < minFanout) {
    return { ok: false, reason: 'no_leader_segments', origin: null, endpoints: [] };
  }

  // Vertex-degree map: each quantized vertex collects the opposite endpoints
  // of the long segments that touch it.
  const key = (p) => `${Math.round(p[0] / snap) * snap},${Math.round(p[1] / snap) * snap}`;
  const verts = new Map(); // key -> { pt:[x,y], ends:[[x,y],...] }
  const add = (p, other) => {
    const k = key(p);
    let v = verts.get(k);
    if (!v) verts.set(k, (v = { pt: p, ends: [] }));
    v.ends.push(other);
  };
  for (const [a, b] of longNear) {
    add(a, b);
    add(b, a);
  }

  // Fan origin = highest fan-out vertex; ties broken by proximity to the anchor.
  let best = null;
  for (const v of verts.values()) {
    if (
      !best ||
      v.ends.length > best.ends.length ||
      (v.ends.length === best.ends.length && dist2(v.pt, anchor) < dist2(best.pt, anchor))
    ) {
      best = v;
    }
  }
  if (!best || best.ends.length < minFanout) {
    return { ok: false, reason: 'no_fan_origin', origin: null, endpoints: [] };
  }

  // Dedupe endpoints (a quantized origin can collect near-identical tips).
  const dw2 = dedupeWithin * dedupeWithin;
  const endpoints = [];
  for (const e of best.ends) {
    if (!endpoints.some((p) => dist2(p, e) < dw2)) endpoints.push(e);
  }

  return { ok: true, origin: best.pt, endpoints, fanout: endpoints.length };
}
