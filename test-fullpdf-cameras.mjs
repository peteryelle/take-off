// test-fullpdf-cameras.mjs — gate the REAL 39-page QTS render through the shipped
// vector pipeline. The 4-page subset froze pg3 -> 17; this proves the SAME sheet in
// the full set (the one the live run reported as 48) extracts to 17 offline, and
// locks pg4 -> 2. So any over-count is environment/deploy drift, not the algorithm.
// Sub-paths are frozen (normalized red) in fixtures/qts-full-cameras-subpaths.json
// so the 51MB PDF isn't needed at gate time.
// Run: node test-fullpdf-cameras.mjs
import { groupSubpaths, classifyCameraBlob } from './public/lib/geometry.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const assert = (c, m) => { if (c) console.log('  PASS ', m); else { console.log('  FAIL ', m); failures++; } };
const fx = JSON.parse(readFileSync(new URL('./fixtures/qts-full-cameras-subpaths.json', import.meta.url)));

const tally = (pno) => {
  const blobs = groupSubpaths(fx.pages[pno].subpaths, { bodyArea: 2e-5 });
  const cls = blobs.map((b) => classifyCameraBlob(b));
  const n = (t) => cls.filter((c) => c.type === t).length;
  return { total: blobs.length, one: n('1-lens'), three: n('3-lens'), four: n('4-lens') };
};

console.log('full-PDF page 3 (SITE SECURITY PLAN SE01-00) — locked 17 = 11/2/4:');
const p3 = tally('3');
assert(fx.pages['3'].n_subpaths === 154, `154 red sub-paths frozen (got ${fx.pages['3'].n_subpaths})`);
assert(p3.total === 17, `17 cameras (got ${p3.total})`);
assert(p3.one === 11 && p3.three === 2 && p3.four === 4,
  `split 11/2/4 (got ${p3.one}/${p3.three}/${p3.four})`);

console.log('full-PDF page 4 (QTS RIC5 DC1 SE01-01) — locked 2:');
const p4 = tally('4');
assert(p4.total === 2, `2 cameras (got ${p4.total})`);

console.log(failures ? `\n${failures} FAILED` : '\nall PASS');
process.exit(failures ? 1 : 0);
