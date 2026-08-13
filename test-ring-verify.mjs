// Gate: ring verification for symbol types whose real glyph is a filled shape
// inside a circular OUTLINE (e.g. WAP) — fill+area alone can't distinguish a real
// one from other similarly-sized, similarly-colored shapes on the sheet. Confirmed
// on a real project: wall lines, a wall pass-thru symbol, and a wall-mounted VOIP
// triangle (same shape family as the real glyph, minus the circle) were all being
// counted as WAP. A candidate with no matching encircling ring is dropped
// outright — the ring's absence is decisive negative evidence for this glyph
// family, not an ambiguous case needing a flag.
import { isCircleLike, findEncirclingRing } from './public/lib/geometry.js';
import { blobsToInstances } from './public/lib/locate.js';

let fail = 0; const A = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

// Build a closed circle's point loop for fixtures.
const circlePoints = (cx, cy, r, n = 16) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// ── isCircleLike: pure geometry ─────────────────────────────────────
console.log('isCircleLike:');
A(isCircleLike(circlePoints(0.5, 0.5, 0.02)) !== null, 'a real circle loop is recognized');
A(isCircleLike([[0.49, 0.49], [0.51, 0.49], [0.50, 0.52]]) === null, 'a 3-point triangle is not (too few points)');
A(isCircleLike(circlePoints(0.5, 0.5, 0.02).map(([x, y], i) => i === 0 ? [x + 0.05, y] : [x, y])) === null,
  'a loop with one wildly displaced vertex is not circle-like (blown variance)');

// ── findEncirclingRing: pure geometry ───────────────────────────────
console.log('findEncirclingRing:');
const ringStrokes = [{ points: circlePoints(0.5, 0.5, 0.02), filled: false }];
A(findEncirclingRing([0.5, 0.5], 0.01, ringStrokes) !== null, 'ring genuinely wrapping the blob is found');
A(findEncirclingRing([0.8, 0.8], 0.01, ringStrokes) === null, 'a circle nowhere near the blob is not treated as its ring');
A(findEncirclingRing([0.5, 0.5], 0.03, ringStrokes) === null,
  'a circle SMALLER than (or barely bigger than) the blob is rejected — must genuinely wrap around it');
A(findEncirclingRing([0.5, 0.5], 0.001, [{ points: circlePoints(0.5, 0.5, 10), filled: false }]) === null,
  'an absurdly oversized circle elsewhere on the sheet is rejected (maxRadiusRatio)');

// ── blobsToInstances integration: the full wiring a real page goes through ──
console.log('blobsToInstances (requires_ring integration):');
const triangleBody = [[0.49, 0.49], [0.51, 0.49], [0.50, 0.52], [0.49, 0.49]]; // small filled triangle, area ~3e-4
const blobWithRing = { x: 0.50, y: 0.503, fill_rgb: [127, 127, 127], paths: [{ points: triangleBody, closed: true, filled: true }] };
const blobNoRing   = { x: 0.70, y: 0.703, fill_rgb: [127, 127, 127], paths: [{ points: triangleBody.map(([x, y]) => [x + 0.20, y + 0.20]), closed: true, filled: true }] };
const group = { single_type: 'WIRELESS ACCESS POINT', requires_ring: true };
const strokeSubpaths = [{ points: circlePoints(0.50, 0.503, 0.02), filled: false }]; // only near blobWithRing

const kept = blobsToInstances([blobWithRing, blobNoRing], group, { strokeSubpaths });
A(kept.length === 1, `only the ringed blob survives (got ${kept.length})`);
A(kept[0]?.type === 'WIRELESS ACCESS POINT', 'the surviving instance keeps the correct type');

// Same two blobs, requires_ring OFF — every other symbol type's existing behavior
// (single_type without a ring requirement) must be completely unaffected.
const groupNoRingReq = { single_type: 'WIRELESS ACCESS POINT', requires_ring: false };
const unfiltered = blobsToInstances([blobWithRing, blobNoRing], groupNoRingReq, { strokeSubpaths });
A(unfiltered.length === 2, `requires_ring:false is a no-op — both blobs pass through unchanged (got ${unfiltered.length})`);

// Mutation tripwire: requires_ring true but NO strokeSubpaths supplied at all (a
// caller that forgot to thread them through) — must reject everything, not
// silently fall back to accepting all blobs. Fixture would otherwise mask the
// wiring gap this whole feature exists to prevent.
const noStrokesGiven = blobsToInstances([blobWithRing, blobNoRing], group, {});
A(noStrokesGiven.length === 0, 'requires_ring with no strokeSubpaths rejects everything, does not silently accept all');

console.log(fail ? `\n${fail} FAILED` : '\nall PASS');
process.exit(fail ? 1 : 0);
