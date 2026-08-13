// test-signature-qts.mjs — REAL-DATA classification gate (the 4/2/11 fixture).
// Where test-signature.mjs gates the algorithm on synthetic cones, this gates it
// on the actual QTS RIC5 DC1 camera geometry, extracted from the PDF vector layer.
//
// fixtures/qts-cameras-17.json was produced from the real extract: red-filled
// sub-paths -> connectivity regroup -> the one 3-way merge split by its ground-truth
// clusters -> 17 per-camera blobs (this split is what label-anchoring does in
// production; here it is done once to isolate the CLASSIFIER from the grouping).
//
// Ground truth: 11 single-lens directional + 2 three-lens hubs + 4 four-lens hubs.
// The honest result (matching the handoff's own finding that the 3-vs-4 call is not
// reliably automatable): the classifier is CONFIDENT on the 11 directional and the
// 4 symmetric four-lens hubs (15/17), and FLAGS the 2 asymmetric hubs for the
// cluster-and-ring verifier rather than forcing a possibly-wrong count.
// Run: node test-signature-qts.mjs
import { computeSignature, countRadialArms } from '../public/lib/signature.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const blobs = JSON.parse(readFileSync(new URL('./fixtures/qts-cameras-17.json', import.meta.url)));

// The classifier: aspect splits directional (elongated body) from multisensor hub
// (compact, symmetric); for hubs, radial-arm count + symmetry gives the lens count
// and a confidence. Directional cameras in this set are all single-lens.
const ASPECT_HUB_MAX = 2.2;
function classify(blob) {
  const sig = computeSignature(blob);
  if (sig.aspect > ASPECT_HUB_MAX) return { type: '1-lens', confident: true };
  const { arms, confident } = countRadialArms(blob);
  if (confident && arms === 4) return { type: '4-lens', confident: true };
  // arms===3, or an asymmetric 4 — the documented ambiguous 3-vs-4 call.
  return { type: '3-lens', confident: false, flag: 'verify_lens_count' };
}

const results = blobs.map(classify);
const n = (t) => results.filter((r) => r.type === t).length;

console.log('counts:');
assert(blobs.length === 17, `17 cameras in fixture (got ${blobs.length})`);
assert(n('1-lens') === 11, `11 single-lens directional (got ${n('1-lens')})`);
assert(n('4-lens') === 4,  `4 four-lens hubs (got ${n('4-lens')})`);
assert(n('3-lens') === 2,  `2 three-lens hubs (got ${n('3-lens')})`);
assert(n('1-lens') + n('3-lens') + n('4-lens') === 17, '4/2/11 = 17 total');

console.log('confidence (the human-in-the-loop split):');
const confident = results.filter((r) => r.confident).length;
const flagged = results.filter((r) => r.flag === 'verify_lens_count');
assert(confident === 15, `15 confident deterministic calls: 11 directional + 4 symmetric hubs (got ${confident})`);
assert(flagged.length === 2 && flagged.every((r) => r.type === '3-lens'),
  `2 asymmetric hubs flagged for ring verification (got ${flagged.length})`);

console.log('arm symmetry separates clean 4-lens from ambiguous hubs:');
const hubs = blobs.map((b) => ({ b, sig: computeSignature(b) })).filter((x) => x.sig.aspect <= ASPECT_HUB_MAX)
  .map((x) => countRadialArms(x.b));
const symmetric = hubs.filter((h) => h.confident && h.arms === 4).length;
assert(symmetric === 4, `4 hubs read as evenly-spaced four-arm (got ${symmetric})`);

console.log(`\n${failures === 0 ? 'ALL PASS — 4/2/11 locked on real geometry (2 hubs flagged for verify)' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
