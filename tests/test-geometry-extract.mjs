// test-geometry-extract.mjs — IMPURE extraction-faithfulness gate (excluded from the
// routine suite loop; runs only when pdfjs-dist + the source PDF are present, like the
// other image/PDF harnesses). Proves the SHARED geometry.js operator-walker reproduces
// the frozen sub-path fixture the pure gate (test-geometry.mjs) trusts — closing the
// loop: live extraction == frozen fixture == classifier gate. pdf.js is INJECTED here
// via pdfjs-dist's OPS, exactly as the browser injects the CDN build at runtime.
//
// Setup (one-time):  npm install pdfjs-dist@3.11.174 --no-save
// Run:               node test-geometry-extract.mjs   (SKIPs cleanly if deps absent)
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PDF_PATH = new URL('./public/tools/QTS_1page.pdf', import.meta.url);

function loadPdfjs() {
  try { return require('pdfjs-dist/legacy/build/pdf.js'); } catch { return null; }
}
const pdfjs = loadPdfjs();
if (!pdfjs || !pdfjs.OPS || !existsSync(PDF_PATH)) {
  console.log('SKIP  test-geometry-extract — pdfjs-dist and/or QTS_1page.pdf not present.');
  console.log('      (install pdfjs-dist@3.11.174 to run the real-PDF extraction check;');
  console.log('       the pure grouping+classify gate runs in test-geometry.mjs regardless.)');
  process.exit(0);
}

const { contentFrame, extractFilledSubpaths, filterByFill, groupSubpaths, classifyCameraBlob } =
  await import('../public/lib/geometry.js');

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const data = new Uint8Array(readFileSync(PDF_PATH));
const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 1.0 });

// text centres (user space) for the frame — same derivation as getDeviceTextItems
const tc = await page.getTextContent({ includeMarkedContent: false });
const centers = [];
for (const it of tc.items) {
  const s = (it.str || '').trim().replace(/[^\x20-\x7E]/g, '').trim();
  if (!s) continue;
  const fs = Math.abs(it.transform[3]);
  centers.push({ cx: it.transform[4] + (it.width || 0) / 2, cy: it.transform[5] + (it.height || fs) / 2 });
}
const frame = contentFrame(centers, vp.width, vp.height);

const rawRaw = await extractFilledSubpaths(page, pdfjs.OPS);
const normed = rawRaw.map((s) => ({ ...s, points: s.points.map(([x, y]) => frame.norm(x, y)) }));
const red = filterByFill(normed, [255, 87, 87], 48);

const fx = JSON.parse(readFileSync(new URL('./fixtures/qts-cameras-subpaths.json', import.meta.url)));

console.log('shared-module extraction reproduces the frozen sub-path bag:');
assert(red.length === fx.n_subpaths, `${fx.n_subpaths} red sub-paths from the live operator list (got ${red.length})`);

// centroid multiset must match the frozen fixture exactly (same walker, same bezier n)
const key = (s) => {
  let sx = 0, sy = 0; for (const [x, y] of s.points) { sx += x; sy += y; }
  return `${(sx / s.points.length).toFixed(4)},${(sy / s.points.length).toFixed(4)}`;
};
const liveSet = red.map(key).sort().join('|');
const frozenSet = fx.subpaths.map(key).sort().join('|');
assert(liveSet === frozenSet, 'sub-path centroid multiset matches the frozen fixture (extraction is faithful)');

console.log('end-to-end on the live PDF = locked 4/2/11:');
const blobs = groupSubpaths(red, { bodyArea: 2e-5 });
const cls = blobs.map((b) => classifyCameraBlob(b));
const n = (t) => cls.filter((c) => c.type === t).length;
assert(blobs.length === 17, `17 camera bodies from the live extract (got ${blobs.length})`);
assert(n('1-lens') === 11 && n('4-lens') === 4 && n('3-lens') === 2, `4/2/11 split (got ${n('1-lens')}/${n('4-lens')}/${n('3-lens')} as 1/4/3-lens)`);

console.log(`\n${failures === 0 ? 'ALL PASS — live operator-walker == frozen fixture == 4/2/11' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
