// One-shot: hand-seed the 3 QTS camera prototypes from the frozen sub-path bag, each
// stamped with the STABLE join token that will also be written to the row's
// detection_config.type (reconcile joins symbols by cfg.type || name; we set cfg.type
// explicitly so the join never depends on display-name punctuation). Mapping to the
// real QTS rows (project 5): 64 "1 Lens Camera"=cam_1lens, 65 "3 lens camera"=cam_3lens,
// 62 "4 lens camera"=cam_4lens. Replaced by the box-select UI (substep 7).
import { groupSubpaths, classifyCameraBlob } from './public/lib/geometry.js';
import { computeSignature, prototypeFromSignatures } from './public/lib/signature.js';
import { readFileSync, writeFileSync } from 'node:fs';

const LENS_TO_TOKEN = { '1-lens': 'cam_1lens', '3-lens': 'cam_3lens', '4-lens': 'cam_4lens' };
const fx = JSON.parse(readFileSync('fixtures/qts-cameras-subpaths.json'));
const blobs = groupSubpaths(fx.subpaths, { bodyArea: 2e-5 });
const ruled = blobs.map((b) => ({ b, c: classifyCameraBlob(b) }));
const pick = (lens) => ruled.filter((r) => r.c.type === lens).map((r) => computeSignature(r.b));
const protos = ['1-lens', '3-lens', '4-lens'].map((lens) => {
  const p = prototypeFromSignatures(LENS_TO_TOKEN[lens], pick(lens));
  return { ...p, lens_class: lens };          // keep lens_class for human readability
}).filter((p) => p.sig);

writeFileSync('fixtures/qts-camera-prototypes.json', JSON.stringify({
  _note: 'Hand-seeded QTS camera prototypes for detection_config.symbol_template. type = the stable join token written to each row cfg.type. Replaced by box-select (substep 7).',
  fill_rgb: [255, 87, 87], fill_tol: 48, body_area: 2e-5,
  prototypes: protos,
}, null, 2));
console.log('wrote prototypes:', protos.map((p) => `${p.type}<=${p.lens_class}(n=${p.n})`).join(', '));
