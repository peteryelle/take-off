// test-stitch-runs.mjs — locks in the three real cases found while this was
// still inline in multi-page.html (see that file's history / stitch-runs.js
// header for the real production capture this was built against).
// Run: node --test tests/test-stitch-runs.mjs
import { stitchRuns } from '../public/lib/stitch-runs.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

console.log('Real cases from production (T-500 sheet):');
{
  const title = stitchRuns([
    { s: 'TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCH', cy: 100, left: 260, right: 340, fs: 10 },
    { s: 'EDULE', cy: 100, left: 341, right: 355, fs: 10 },
  ]);
  assert(title.length === 1 && title[0].s === 'TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCHEDULE',
    `mid-word split merges with no space (got ${JSON.stringify(title.map((r) => r.s))})`);

  const footer = stitchRuns([
    { s: 'SEE ENLARGED DATA ROOM PLANS FOR TELECOMMUNICATIONS', cy: 200, left: 150, right: 250, fs: 10 },
    { s: 'ROOM EQUIPMENT LOCATIONS.', cy: 200, left: 253, right: 305, fs: 10 },
  ]);
  assert(footer.length === 1 && footer[0].s === 'SEE ENLARGED DATA ROOM PLANS FOR TELECOMMUNICATIONS ROOM EQUIPMENT LOCATIONS.',
    `word-boundary split merges WITH a space (got ${JSON.stringify(footer.map((r) => r.s))})`);

  const cols = stitchRuns([
    { s: 'BUILDING NUMBER', cy: 100, left: 245, right: 275, fs: 10 },
    { s: 'LEVEL', cy: 100, left: 286, right: 298, fs: 10 },
  ]);
  assert(cols.length === 2 && cols[0].s === 'BUILDING NUMBER' && cols[1].s === 'LEVEL',
    `real separate table columns (11pt gap) never merge (got ${JSON.stringify(cols.map((r) => r.s))})`);
}

console.log('Edge cases:');
{
  assert(stitchRuns([]).length === 0, 'empty input -> [], no throw');

  const singleItem = stitchRuns([{ s: 'ALONE', cy: 50, left: 0, right: 20, fs: 10 }]);
  assert(singleItem.length === 1 && singleItem[0].s === 'ALONE', 'a single item passes through unchanged');

  // Different lines (large y difference) never merge regardless of x gap.
  const diffLines = stitchRuns([
    { s: 'LINE ONE', cy: 100, left: 0, right: 50, fs: 10 },
    { s: 'LINE TWO', cy: 200, left: 0, right: 50, fs: 10 },
  ]);
  assert(diffLines.length === 2, 'items on genuinely different lines (large y gap) stay separate');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
