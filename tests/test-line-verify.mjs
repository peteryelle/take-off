// Gate: line-through-center verification for symbol types whose real glyph is a
// circle with a straight line through its center (confirmed via the project's
// own validated Discovery description: "SHAPE: Circle with horizontal line
// (diameter) through center") — not the ring/triangle shape earlier attempts
// wrongly assumed. Mirrors test-ring-verify.mjs's structure: same local-
// neighborhood + stitching pattern (real lines can be drawn as many short
// disconnected segments too, not one continuous stroke), fitted via 2D total-
// least-squares instead of a circle fit.
import { isLineLike, findLineThroughCenter, stitchSegments } from '../public/lib/geometry.js';
import { blobsToInstances } from '../public/lib/locate.js';

let fail = 0; const A = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

// Build a straight line's point loop for fixtures — cx,cy is the line's own
// midpoint, len is its full length, angle in radians.
const linePoints = (cx, cy, len, angle = 0, n = 12) =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1) - 0.5) * len;
    return [cx + t * Math.cos(angle), cy + t * Math.sin(angle)];
  });

const circlePoints = (cx, cy, r, n = 16) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

const asFragments = (points) =>
  points.map((p, i) => i + 1 < points.length ? { points: [p, points[i + 1]], filled: false } : null).filter(Boolean);

// ── isLineLike: pure geometry ────────────────────────────────────────
console.log('isLineLike:');
A(isLineLike(linePoints(0.5, 0.5, 0.02, 0)) !== null, 'a real straight line is recognized');
A(isLineLike(circlePoints(0.5, 0.5, 0.02)) === null, 'a circle is not a line');
A(isLineLike([[0.49, 0.5], [0.51, 0.5]]) === null, 'a bare 2-point segment is not enough (needs 4+)');
A(isLineLike(linePoints(0.5, 0.5, 0.02, Math.PI / 4)) !== null, 'a diagonal line is recognized too (not axis-dependent)');

// ── findLineThroughCenter: pure geometry ─────────────────────────────
console.log('findLineThroughCenter:');
const centerLine = [{ points: linePoints(0.5, 0.5, 0.02, 0), filled: false }]; // length 0.02, through (0.5,0.5)
A(findLineThroughCenter([0.5, 0.5], 0.008, centerLine) !== null,
  'a line genuinely through the blob center, diameter-ish length, is found');
A(findLineThroughCenter([0.8, 0.8], 0.008, centerLine) === null,
  'a line nowhere near the blob is not treated as its center line');
A(findLineThroughCenter([0.5, 0.5], 0.008, [{ points: linePoints(0.5, 0.5, 0.002, 0), filled: false }]) === null,
  'a line much SHORTER than the blob diameter is rejected (minLenRatio)');
A(findLineThroughCenter([0.5, 0.5], 0.001, [{ points: linePoints(0.5, 0.5, 0.05, 0), filled: false }]) === null,
  'a line absurdly longer than the blob diameter is rejected (maxLenRatio)');
A(findLineThroughCenter([0.5, 0.52], 0.008, centerLine) === null,
  'a line offset well off the blob center (not through it) is rejected');

// The real-world case: line drawn as many disconnected short fragments.
const fragmentedLine = asFragments(linePoints(0.5, 0.5, 0.02, 0, 20));
A(findLineThroughCenter([0.5, 0.5], 0.008, fragmentedLine) !== null,
  'a line made of disconnected fragments is still found (same production pattern as the ring bug)');

// ── blobsToInstances integration ─────────────────────────────────────
console.log('blobsToInstances (requires_line_through_center integration):');
const triangleBody = [[0.49, 0.49], [0.51, 0.49], [0.50, 0.52], [0.49, 0.49]];
const blobWithLine = { x: 0.50, y: 0.503, fill_rgb: [127, 127, 127], paths: [{ points: triangleBody, closed: true, filled: true }] };
const blobNoLine   = { x: 0.70, y: 0.703, fill_rgb: [127, 127, 127], paths: [{ points: triangleBody.map(([x, y]) => [x + 0.20, y + 0.20]), closed: true, filled: true }] };
const group = { single_type: 'WAP', requires_line_through_center: true };
const strokeSubpaths = [{ points: linePoints(0.50, 0.503, 0.02, 0), filled: false }]; // only near blobWithLine

const kept = blobsToInstances([blobWithLine, blobNoLine], group, { strokeSubpaths });
A(kept.length === 1, `only the blob with a line through it survives (got ${kept.length})`);
A(kept[0]?.type === 'WAP', 'the surviving instance keeps the correct type');

const fragmentedStrokes = asFragments(linePoints(0.50, 0.503, 0.02, 0, 20));
const keptFragmented = blobsToInstances([blobWithLine, blobNoLine], group, { strokeSubpaths: fragmentedStrokes });
A(keptFragmented.length === 1, `fragmented line: only the correct blob survives (got ${keptFragmented.length})`);

const groupOff = { single_type: 'WAP', requires_line_through_center: false };
const unfiltered = blobsToInstances([blobWithLine, blobNoLine], groupOff, { strokeSubpaths });
A(unfiltered.length === 2, `requires_line_through_center:false is a no-op (got ${unfiltered.length})`);

const noStrokesGiven = blobsToInstances([blobWithLine, blobNoLine], group, {});
A(noStrokesGiven.length === 0, 'requires_line_through_center with no strokeSubpaths rejects everything, does not silently accept all');

// Both checks can be set on the same group without interfering — a blob must
// pass whichever check(s) are active. Confirms the two features are additive,
// not mutually exclusive in the code even though a real config only sets one.
const bothGroup = { single_type: 'WAP', requires_ring: false, requires_line_through_center: true };
const keptBoth = blobsToInstances([blobWithLine, blobNoLine], bothGroup, { strokeSubpaths });
A(keptBoth.length === 1, 'requires_ring:false alongside requires_line_through_center:true only applies the line check');

console.log(fail ? `\n${fail} FAILED` : '\nall PASS');
process.exit(fail ? 1 : 0);
