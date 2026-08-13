// test-geometry.mjs — OFFLINE gate for the geometry adapter (substep 3, "keystone").
// Pure and fast: reads the frozen pre-grouping sub-path bag (fixtures/qts-cameras-
// subpaths.json, 154 red sub-paths from QTS_1page.pdf p1) and gates the LOCATION
// half of the symbol track — grouping + the lens-class call — end to end to the
// locked 4/2/11. No pdf.js, no 33MB PDF (that path is gated separately, and only
// when present, by test-geometry-extract.mjs). The classifier ALGORITHM itself is
// gated on the pre-split per-camera blobs by test-signature-qts.mjs; this gate adds
// the grouping that produces those blobs from raw sub-paths.
//
// Ground truth (QTS RIC5 DC1): 11 single-lens directional + 4 four-lens hubs
// + 2 three-lens hubs = 17. The 2 asymmetric hubs are FLAGGED for the ring verifier
// rather than force a possibly-wrong 3-vs-4 call (brittleness -> human).
// Run: node test-geometry.mjs
import { contentFrame, groupSubpaths, classifyCameraBlob } from '../public/lib/geometry.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const fx = JSON.parse(readFileSync(new URL('./fixtures/qts-cameras-subpaths.json', import.meta.url)));

console.log('frame contract (the getDeviceTextItems frame, single-sourced):');
// Synthetic check of the normalization formula: content bounds from text centres,
// y flipped, anisotropic per-axis. A point at the bounds maps to 0/1; centre to .5.
const fr = contentFrame([{ cx: 100, cy: 100 }, { cx: 300, cy: 500 }], 50, 50);
assert(JSON.stringify(fr.norm(100, 100)) === JSON.stringify([0, 1]), 'min-x / min-y corner -> [0,1] (y flipped)');
assert(JSON.stringify(fr.norm(300, 500)) === JSON.stringify([1, 0]), 'max-x / max-y corner -> [1,0]');
assert(JSON.stringify(fr.norm(200, 300)) === JSON.stringify([0.5, 0.5]), 'centre -> [0.5,0.5]');

console.log('fixture integrity:');
assert(fx.n_subpaths === 154 && fx.subpaths.length === 154, `154 red sub-paths frozen (got ${fx.subpaths.length})`);
const inUnit = fx.subpaths.every((s) => s.points.every(([x, y]) => x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01));
assert(inUnit, 'all sub-path points are in the normalized [0,1] frame');

console.log('grouping recovers the cameras (body-area + nearest-member):');
const blobs = groupSubpaths(fx.subpaths, { bodyArea: 2e-5 });
assert(blobs.length === 17, `17 camera bodies recovered at bodyArea=2e-5 (got ${blobs.length})`);

console.log('grouping tolerance plateau (drift made visible, not hidden):');
const at = (ba) => groupSubpaths(fx.subpaths, { bodyArea: ba }).length;
assert(at(1e-5) === 17 && at(2e-5) === 17, `17 holds across the 1e-5..2e-5 plateau (got ${at(1e-5)}, ${at(2e-5)})`);
assert(at(3e-5) < 17, `above the plateau bodies collapse (3e-5 -> ${at(3e-5)}), so 2e-5 sits mid-plateau`);

console.log('lens-class split = locked 4/2/11:');
const cls = blobs.map((b) => classifyCameraBlob(b));
const n = (t) => cls.filter((c) => c.type === t).length;
assert(n('1-lens') === 11, `11 single-lens directional (got ${n('1-lens')})`);
assert(n('4-lens') === 4, `4 four-lens hubs (got ${n('4-lens')})`);
assert(n('3-lens') === 2, `2 three-lens hubs (got ${n('3-lens')})`);
assert(n('1-lens') + n('3-lens') + n('4-lens') === 17, '4/2/11 = 17 total');

console.log('honest flagging (the human-in-the-loop split):');
const confident = cls.filter((c) => c.confidence === 'high').length;
const flagged = cls.filter((c) => c.flag === 'verify_lens_count');
assert(confident === 15, `15 confident deterministic calls (11 directional + 4 symmetric hubs) (got ${confident})`);
assert(flagged.length === 2 && flagged.every((c) => c.type === '3-lens'), `2 asymmetric hubs flagged for ring verification (got ${flagged.length})`);

console.log('symbol_instances shape (what reconcile consumes):');
const instances = blobs.map((b, i) => ({ type: cls[i].type, x: b.x, y: b.y, confidence: cls[i].confidence, flag: cls[i].flag }));
const wellShaped = instances.every((s) => typeof s.type === 'string' && s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1);
assert(wellShaped, 'every instance is { type, x in [0,1], y in [0,1], confidence, flag }');

console.log(`\n${failures === 0 ? 'ALL PASS — adapter groups 154 sub-paths -> 17 cameras -> 4/2/11 (2 flagged for verify)' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
