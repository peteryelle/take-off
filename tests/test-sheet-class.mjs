// test-sheet-class.mjs — OFFLINE gate for the ingest probe (substep 4). Pure and fast:
// gates classifySheetClass against the four-corner synthetic cases AND the real signal
// magnitudes frozen in fixtures/sheet-class-signals.json (measured from the QTS PDFs and
// the VA text-items fixture). The live re-derive from a PDF is gated, only when present,
// by test-sheet-class-extract.mjs. Run: node test-sheet-class.mjs
import { classifySheetClass } from '../public/lib/sheet-class.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

console.log('the 2x2 of text x geometry (raster_only = neither):');
const c = (sig) => classifySheetClass(sig);
const tg = c({ textCharCount: 800, filledSubpathCount: 200 });
assert(tg.vector_text && tg.vector_geometry && !tg.raster_only, 'text + geometry -> vector_text_geometry');
const to = c({ textCharCount: 800, filledSubpathCount: 0, constructPathOps: 0 });
assert(to.vector_text && !to.vector_geometry && !to.raster_only, 'text only -> vector_text, not raster');
const go = c({ textCharCount: 0, filledSubpathCount: 200 });
assert(!go.vector_text && go.vector_geometry && !go.raster_only, 'geometry only -> vector_geometry, not raster');
const ro = c({ textCharCount: 0, filledSubpathCount: 0, constructPathOps: 0, imageAreaFrac: 0.95 });
assert(!ro.vector_text && !ro.vector_geometry && ro.raster_only, 'neither layer -> raster_only');

console.log('line-art sheet (many strokes, few fills) still reads as vector geometry:');
const lineArt = c({ textCharCount: 300, filledSubpathCount: 2, constructPathOps: 5000 });
assert(lineArt.vector_geometry, 'high path-op count alone trips vector_geometry');

console.log('real sheets (frozen measured signals):');
const fx = JSON.parse(readFileSync(new URL('./fixtures/sheet-class-signals.json', import.meta.url)));
for (const s of fx.sheets) {
  const r = classifySheetClass(s);
  for (const [flag, want] of Object.entries(s.expect)) {
    assert(r[flag] === want, `${s.id}: ${flag} = ${want}${s.partial ? '  [partial: ' + s.partial + ']' : ''}`);
  }
}

console.log('threshold margins are not knife-edge (real values clear the cutoffs comfortably):');
const qts = fx.sheets.find((s) => s.id === 'QTS_1page');
assert(qts.textCharCount >= 100 * 2 && qts.filledSubpathCount >= 10 * 2, 'QTS clears text + geometry cutoffs by >=2x');

console.log(`\n${failures === 0 ? 'ALL PASS — probe tags the 2x2 and the real sheets (raster_only synthetic until a scanned set arrives)' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
