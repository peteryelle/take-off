// test-signature.mjs — vector-classifier gate (the deterministic 1/3/4-lens engine).
// Pure synthetic geometry, no PDF. Proves the lobe counter separates 1- vs 3- vs
// 4-lens cameras, that classification routes each to its same-lobe prototype, that
// it is rotation/scale/translation invariant, and — critically — that off-target
// shapes (plain circle, square, a 2-lens) return no_match instead of being coerced
// onto the nearest prototype. Run: node test-signature.mjs
//
// Real-plan calibration (QTS = 4/2/11 = 17, from the extracted red camera paths)
// is the follow-up gate once the geometry-extraction adapter is wired; this gate
// proves the algorithm in isolation, the way reconcile/detect are gated.
import { computeSignature, classifyBlob, sigDistance, prototypeFromSignatures } from './public/lib/signature.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

// ── synthetic glyph builders ────────────────────────────────────────────────
const DEG = Math.PI / 180;
function circle(cx, cy, r, n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
// A thin cone: tip on-axis at rOuter (the spike), base spanning ±half at the hub rim.
function conePts(cx, cy, dirDeg, half = 12, rIn = 1.0, rOut = 2.5) {
  const d = dirDeg * DEG, h = half * DEG;
  return [
    [cx + rIn * Math.cos(d - h), cy + rIn * Math.sin(d - h)],
    [cx + rOut * Math.cos(d),    cy + rOut * Math.sin(d)],     // tip = the radial spike
    [cx + rIn * Math.cos(d + h), cy + rIn * Math.sin(d + h)],
  ];
}
// Camera = hub circle (filled) + a lens "fan" sub-path visiting each cone tip.
// n_subpaths = 2, mirroring the QTS observation (each camera = exactly 2 sub-paths).
function camera(nLens, { cx = 0, cy = 0, scale = 1, rotDeg = 0 } = {}) {
  const dirs = Array.from({ length: nLens }, (_, i) => rotDeg + (360 / nLens) * i + (nLens === 1 ? 0 : 0));
  const hub = circle(cx, cy, 1.0 * scale).map(([x, y]) => [x, y]);
  const fan = [];
  for (const dir of dirs) for (const p of conePts(cx, cy, dir, 12, 1.0 * scale, 2.5 * scale)) fan.push(p);
  return { paths: [{ points: hub, closed: true, filled: true }, { points: fan, closed: false, filled: false }] };
}
function plainCircle({ cx = 0, cy = 0, r = 1.5 } = {}) {
  return { paths: [{ points: circle(cx, cy, r, 64), closed: true, filled: true }] };
}
function square(a = 1.5, { cx = 0, cy = 0 } = {}) {
  return { paths: [{ points: [[cx - a, cy - a], [cx + a, cy - a], [cx + a, cy + a], [cx - a, cy + a]], closed: true, filled: true }] };
}

// ── 1. lobe count is exact for 1/3/4 ────────────────────────────────────────
console.log('lobe counting:');
const s1 = computeSignature(camera(1));
const s3 = computeSignature(camera(3));
const s4 = computeSignature(camera(4));
assert(s1.lobe_count === 1, `1-lens -> lobe_count 1 (got ${s1.lobe_count})`);
assert(s3.lobe_count === 3, `3-lens -> lobe_count 3 (got ${s3.lobe_count})`);
assert(s4.lobe_count === 4, `4-lens -> lobe_count 4 (got ${s4.lobe_count})`);
assert(s4.n_subpaths === 2, `camera has 2 sub-paths (got ${s4.n_subpaths})`);
assert(computeSignature(plainCircle()).lobe_count === 0, 'plain circle -> 0 lobes');
assert(computeSignature(square()).lobe_count === 0, 'square -> 0 lobes (corners are not spikes)');

// ── 2. invariance: rotation, scale, translation give the same call ──────────
console.log('invariance:');
const ref = computeSignature(camera(4));
const rot = computeSignature(camera(4, { rotDeg: 37 }));
const scl = computeSignature(camera(4, { scale: 12 }));
const trn = computeSignature(camera(4, { cx: 500, cy: -300 }));
assert(rot.lobe_count === 4, 'rotated 37deg -> still 4 lobes');
assert(scl.lobe_count === 4, 'scaled 12x -> still 4 lobes');
assert(trn.lobe_count === 4, 'translated -> still 4 lobes');
assert(sigDistance(ref, scl) < 0.05, 'scale gives near-identical signature');
assert(sigDistance(ref, trn) < 0.05, 'translation gives near-identical signature');

// ── 3. classification routes to the same-lobe prototype ─────────────────────
console.log('classification vs plan exemplars:');
const prototypes = [
  prototypeFromSignatures('CAM-1', [computeSignature(camera(1)), computeSignature(camera(1, { rotDeg: 45 }))]),
  prototypeFromSignatures('CAM-3', [computeSignature(camera(3)), computeSignature(camera(3, { rotDeg: 20 }))]),
  prototypeFromSignatures('CAM-4', [computeSignature(camera(4)), computeSignature(camera(4, { rotDeg: 30 }))]),
];
const c1 = classifyBlob(computeSignature(camera(1, { rotDeg: 11, scale: 3 })), prototypes);
const c3 = classifyBlob(computeSignature(camera(3, { rotDeg: 80, scale: 2 })), prototypes);
const c4 = classifyBlob(computeSignature(camera(4, { rotDeg: 5,  scale: 7 })), prototypes);
assert(c1.match === 'matched' && c1.type === 'CAM-1', `1-lens classifies as CAM-1 (got ${c1.type})`);
assert(c3.match === 'matched' && c3.type === 'CAM-3', `3-lens classifies as CAM-3 (got ${c3.type})`);
assert(c4.match === 'matched' && c4.type === 'CAM-4', `4-lens classifies as CAM-4 (got ${c4.type})`);

// ── 4. never force nearest-of-N: off-target shapes are no_match ─────────────
console.log('no_match (the anti-coercion guard):');
const nCircle = classifyBlob(computeSignature(plainCircle()), prototypes);
const nSquare = classifyBlob(computeSignature(square()), prototypes);
const n2lens  = classifyBlob(computeSignature(camera(2)), prototypes);
assert(nCircle.match === 'no_match', `plain circle -> no_match (got ${nCircle.match}/${nCircle.type})`);
assert(nSquare.match === 'no_match', `square -> no_match (got ${nSquare.match}/${nSquare.type})`);
assert(n2lens.match === 'no_match',  `2-lens (not in {1,3,4}) -> no_match (got ${n2lens.match}/${n2lens.type})`);

// ── 5. the 3-vs-4 call (the documented failure point of the LLM path) ───────
console.log('3-vs-4 separation:');
assert(sigDistance(s3, s4) >= 1.0, `3-lens and 4-lens are far apart (d=${sigDistance(s3, s4).toFixed(3)})`);
assert(classifyBlob(s3, [{ type: 'CAM-4', sig: s4 }]).match === 'no_match', '3-lens is NOT coerced onto a 4-lens-only prototype');

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
