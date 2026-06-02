// One-shot: hand-seed the 3 camera prototypes (1/3/4-lens) from the frozen sub-path
// bag, the way Step 1 hand-backfilled the VA configs. These populate
// detection_config.symbol_template for the QTS camera types until the box-select UI
// (substep 7) captures them from user taps. Deterministic from the fixture.
import { groupSubpaths, classifyCameraBlob } from './public/lib/geometry.js';
import { computeSignature, prototypeFromSignatures } from './public/lib/signature.js';
import { readFileSync, writeFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync('fixtures/qts-cameras-subpaths.json'));
const blobs = groupSubpaths(fx.subpaths, { bodyArea: 2e-5 });
const ruled = blobs.map((b) => ({ b, c: classifyCameraBlob(b) }));

// Pick one exemplar blob per lens class (confident where available; the 3-lens
// exemplars are the asymmetric hubs — geometrically valid 3-arm signatures even
// though their COUNT is flagged for human verification).
const pick = (t) => ruled.filter((r) => r.c.type === t).map((r) => computeSignature(r.b));
const protos = ['1-lens', '3-lens', '4-lens']
  .map((t) => prototypeFromSignatures(t, pick(t)))
  .filter((p) => p.sig);

writeFileSync('fixtures/qts-camera-prototypes.json', JSON.stringify({
  _note: 'Hand-seeded camera prototypes for detection_config.symbol_template, from QTS_1page sub-paths. Replaced by the box-select UI (substep 7).',
  fill_rgb: [255, 87, 87], fill_tol: 48, body_area: 2e-5,
  prototypes: protos,
}, null, 2));
console.log('wrote fixtures/qts-camera-prototypes.json:', protos.map((p) => `${p.type}(n=${p.n})`).join(', '));
