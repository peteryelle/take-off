// Gate: ring verification for symbol types whose real glyph is a filled shape
// inside a circular OUTLINE (e.g. WAP) — fill+area alone can't distinguish a real
// one from other similarly-sized, similarly-colored shapes on the sheet. Confirmed
// on a real project: wall lines, a wall pass-thru symbol, and a wall-mounted VOIP
// triangle (same shape family as the real glyph, minus the circle) were all being
// counted as WAP. A candidate with no matching encircling ring is dropped
// outright — the ring's absence is decisive negative evidence for this glyph
// family, not an ambiguous case needing a flag.
import { isCircleLike, findEncirclingRing, stitchSegments } from './public/lib/geometry.js';
import { blobsToInstances } from './public/lib/locate.js';

let fail = 0; const A = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

// Build a closed circle's point loop for fixtures.
const circlePoints = (cx, cy, r, n = 16) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// Break a closed point loop into many independent 2-point stroke subpaths —
// exactly the real-world shape confirmed on a production project: a WAP's
// encircling ring was 55 separate 2-point segments, each its own moveTo/
// lineTo/stroke, not one continuous path. Every individual piece is far too
// short for isCircleLike to recognize on its own.
const asFragments = (points) =>
  points.map((p, i) => ({ points: [p, points[(i + 1) % points.length]], filled: false }));

// ── isCircleLike: pure geometry ─────────────────────────────────────
console.log('isCircleLike:');
A(isCircleLike(circlePoints(0.5, 0.5, 0.02)) !== null, 'a real circle loop is recognized');
A(isCircleLike([[0.49, 0.49], [0.51, 0.49], [0.50, 0.52]]) === null, 'a 3-point triangle is not (too few points)');
A(isCircleLike(circlePoints(0.5, 0.5, 0.02).map(([x, y], i) => i === 0 ? [x + 0.05, y] : [x, y])) === null,
  'a loop with one wildly displaced vertex is not circle-like (blown variance)');

// ── stitchSegments: pure geometry ────────────────────────────────────
console.log('stitchSegments:');
{
  const fragments = asFragments(circlePoints(0.5, 0.5, 0.02, 20));
  const stitched = stitchSegments(fragments, 0.001);
  A(stitched.length === 1, `20 disconnected 2-point fragments stitch into one chain (got ${stitched.length} chain(s))`);
  A(isCircleLike(stitched[0]?.points ?? []) !== null, 'the stitched chain reads as a circle (no individual fragment could)');

  // Mutation tripwire: two genuinely separate fragments with a real gap between
  // them must NOT get stitched together — proves the tolerance is a real gate,
  // not stitching anything within vague proximity.
  const farApart = [
    { points: [[0.1, 0.1], [0.1, 0.11]], filled: false },
    { points: [[0.9, 0.9], [0.9, 0.91]], filled: false }
  ];
  const notStitched = stitchSegments(farApart, 0.001);
  A(notStitched.length === 2, `two fragments with a real gap between them stay separate (got ${notStitched.length})`);
}

// ── findEncirclingRing: pure geometry ───────────────────────────────
console.log('findEncirclingRing:');
const ringStrokes = [{ points: circlePoints(0.5, 0.5, 0.02), filled: false }];
A(findEncirclingRing([0.5, 0.5], 0.01, ringStrokes) !== null, 'ring genuinely wrapping the blob is found');
A(findEncirclingRing([0.8, 0.8], 0.01, ringStrokes) === null, 'a circle nowhere near the blob is not treated as its ring');
A(findEncirclingRing([0.5, 0.5], 0.03, ringStrokes) === null,
  'a circle SMALLER than (or barely bigger than) the blob is rejected — must genuinely wrap around it');
A(findEncirclingRing([0.5, 0.5], 0.001, [{ points: circlePoints(0.5, 0.5, 10), filled: false }]) === null,
  'an absurdly oversized circle elsewhere on the sheet is rejected (maxRadiusRatio)');

// The real-world case: ring drawn as many disconnected short fragments, not one
// closed path. Without stitching this returns null every time (confirmed on
// production data — 0 of 86+ candidates ever passed).
const fragmentedRing = asFragments(circlePoints(0.5, 0.5, 0.02, 24));
A(findEncirclingRing([0.5, 0.5], 0.01, fragmentedRing) !== null,
  'a ring made of 24 disconnected fragments is still found (the actual production bug)');

// The SECOND real-world finding: a ring's fragments mixed with unrelated nearby
// noise fragments at a DIFFERENT distance from the blob (walls, other geometry)
// — confirmed on production data via a distance histogram showing two distinct
// clusters. Stitching the whole neighborhood in one unbanded pass let the noise
// corrupt the fit; band-grouping by distance first should isolate the real
// ring's band from the noise band automatically.
{
  const realRing = asFragments(circlePoints(0.5, 0.5, 0.02, 30));   // ratio 2.0, MORE fragments (like real production data)
  const noise = asFragments(circlePoints(0.5, 0.5, 0.03, 10));      // ratio 3.0 — individually plausible too, fewer fragments
  const mixed = [...realRing, ...noise];
  const found = findEncirclingRing([0.5, 0.5], 0.01, mixed);
  A(found !== null, 'the real ring is still found when mixed with unrelated noise at a different distance');
  A(found && Math.abs(found.radius - 0.02) < 0.002,
    `band priority (most fragments first) picks the REAL ring (r≈0.02), not the individually-plausible noise shell (got r=${found?.radius.toFixed(4)})`);
}

// Mutation regression: a real cluster's own fragments can be spread widely in
// distance from center (confirmed on production data: a genuine outer ring
// cluster spanned dCenter 0.014-0.0195, roughly 6x wider than a bandWidth
// derived from the blob's own size). A fixed-width binning approach split that
// single real cluster into several too-sparse pieces, none of which could
// reconstruct into a circle. Gap-based clustering must keep it together as
// long as there's no unusually large gap WITHIN it.
{
  const spreadRing = circlePoints(0.5, 0.5, 0.02, 24).map(([x, y]) => {
    const dx = x - 0.5, dy = y - 0.5;
    const r = Math.hypot(dx, dy) + (Math.random() - 0.5) * 0.003; // ±0.0015 fragment-to-fragment jitter
    const a = Math.atan2(dy, dx);
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  });
  const fragmented = asFragments(spreadRing);
  A(findEncirclingRing([0.5, 0.5], 0.01, fragmented) !== null,
    'a cluster with real fragment-to-fragment distance jitter (not a mathematically perfect circle) still stitches into one recognized ring');
}

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

// Same integration test, but with the ring as fragments (like real production
// pages) instead of one whole circle — the end-to-end path that actually matters.
const fragmentedStrokes = asFragments(circlePoints(0.50, 0.503, 0.02, 24));
const keptFragmented = blobsToInstances([blobWithRing, blobNoRing], group, { strokeSubpaths: fragmentedStrokes });
A(keptFragmented.length === 1, `fragmented ring: only the ringed blob survives (got ${keptFragmented.length})`);

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
