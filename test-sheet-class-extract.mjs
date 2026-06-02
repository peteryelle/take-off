// test-sheet-class-extract.mjs — IMPURE faithfulness gate for the probe's signal
// gatherer (excluded from the routine loop; runs only with pdfjs-dist + the PDF, like
// the other PDF harnesses). Proves deriveSheetClassSignals on the live QTS PDF
// reproduces the frozen signal magnitudes and classifies vector_text_geometry. pdf.js
// is injected via pdfjs-dist's OPS, mirroring the browser's CDN injection at runtime.
//
// Setup: npm install pdfjs-dist@3.11.174 --no-save     Run: node test-sheet-class-extract.mjs
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PDF_PATH = new URL('./public/tools/QTS_1page.pdf', import.meta.url);
let pdfjs = null;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } catch { /* absent */ }
if (!pdfjs || !pdfjs.OPS || !existsSync(PDF_PATH)) {
  console.log('SKIP  test-sheet-class-extract — pdfjs-dist and/or QTS_1page.pdf not present.');
  console.log('      (the pure probe gate runs in test-sheet-class.mjs regardless.)');
  process.exit(0);
}

const { classifySheetClass, deriveSheetClassSignals } = await import('./public/lib/sheet-class.js');
const { extractFilledSubpaths } = await import('./public/lib/geometry.js');

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const data = new Uint8Array(readFileSync(PDF_PATH));
const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
const page = await doc.getPage(1);

const sig = await deriveSheetClassSignals(page, pdfjs.OPS, { extractFilledSubpaths });
const fx = JSON.parse(readFileSync(new URL('./fixtures/sheet-class-signals.json', import.meta.url)));
const frozen = fx.sheets.find((s) => s.id === 'QTS_1page');

console.log('live signal derivation reproduces the frozen QTS magnitudes:');
assert(sig.textCharCount === frozen.textCharCount, `textCharCount ${frozen.textCharCount} (got ${sig.textCharCount})`);
assert(sig.filledSubpathCount === frozen.filledSubpathCount, `filledSubpathCount ${frozen.filledSubpathCount} (got ${sig.filledSubpathCount})`);
assert(sig.constructPathOps === frozen.constructPathOps, `constructPathOps ${frozen.constructPathOps} (got ${sig.constructPathOps})`);

console.log('live classification = vector_text_geometry:');
const cls = classifySheetClass(sig);
assert(cls.vector_text && cls.vector_geometry && !cls.raster_only, 'QTS_1page -> vector_text + vector_geometry');

console.log(`\n${failures === 0 ? 'ALL PASS — live probe == frozen signals == vector_text_geometry' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
