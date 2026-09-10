// test-rack-assembly-rules.js — real T-500 rows as fixtures, plus the
// cassette-count worked examples confirmed directly with the user.
// Run: node --test tests/test-rack-assembly-rules.mjs
import {
  distributePatchPanels, sidecarCount, cassetteCountPerCore, totalCassetteCount,
} from '../public/lib/rack-assembly-rules.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

console.log('Patch panel distribution (T-501 Drawing Note 2), real T-500 rows:');
{
  // A132A-1: 12 panels, 2 racks (confirmed real rack count, proven this session)
  assert(JSON.stringify(distributePatchPanels(12, 2)) === JSON.stringify([6, 6]),
    'A132A-1: 12 panels / 2 racks -> [6,6]');

  // EB51A: 10 panels, 3 racks (confirmed real rack count via leader-fan tracing)
  assert(JSON.stringify(distributePatchPanels(10, 3)) === JSON.stringify([4, 3, 3]),
    'EB51A: 10 panels / 3 racks -> [4,3,3] (remainder goes to first rack)');

  // FB28L-1: 2 panels, 2 racks (confirmed real rack count)
  assert(JSON.stringify(distributePatchPanels(2, 2)) === JSON.stringify([1, 1]),
    'FB28L-1: 2 panels / 2 racks -> [1,1]');

  // A030A-1: 6 panels, 1 rack (confirmed real rack count)
  assert(JSON.stringify(distributePatchPanels(6, 1)) === JSON.stringify([6]),
    'A030A-1: 6 panels / 1 rack -> [6]');

  // sum-preservation property: distributing never loses or invents panels
  const dist = distributePatchPanels(11, 3);
  assert(dist.reduce((a, b) => a + b, 0) === 11, 'distribution always sums back to the original total (11 panels / 3 racks)');
}

console.log('\nEdge cases:');
{
  assert(distributePatchPanels(6, 0).length === 0, 'zero racks -> empty array, not a divide-by-zero throw');
  assert(JSON.stringify(distributePatchPanels(0, 2)) === JSON.stringify([0, 0]), 'zero panels, real racks -> [0,0], not skipped');
}

console.log('\nSidecar sharing (T-501 Coded Note 2 — N racks share N+1 sidecars):');
{
  assert(sidecarCount(2) === 3, 'A132A-1: 2 racks -> 3 sidecars (not 2x2=4)');
  assert(sidecarCount(3) === 4, 'EB51A: 3 racks -> 4 sidecars');
  assert(sidecarCount(1) === 2, '1 rack -> 2 sidecars (one per side, even for a single rack)');
  assert(sidecarCount(0) === 0, 'DB97-1 (0 racks, existing/no new scope) -> 0 sidecars, not 1');
}

console.log('\nFiber cassette count (T-501 Coded Note 3 — ceiling division, not a flat "12 cassettes"):');
{
  // The exact worked example confirmed with the user: 24 strands / 12 per
  // cassette = 2 cassettes minimum for the OSP case.
  assert(cassetteCountPerCore('OSP') === 2, 'OSP (24-strand OS2 only): ceil(24/12) = 2 cassettes per core');
  assert(cassetteCountPerCore('ISP') === 3, 'ISP (24 OM4 + 12 OS1/OS2 = 36 strands): ceil(36/12) = 3 cassettes per core');
  assert(totalCassetteCount('OSP') === 4, 'OSP total (both cores): 2 + 2 = 4, not the workbook\'s flat 12');
  assert(totalCassetteCount('ISP') === 6, 'ISP total (both cores): 3 + 3 = 6, not the workbook\'s flat 12');

  // Never silently trust a hardcoded "12 cassettes fits everything" -- confirm
  // the formula actually scales if capacity or strand count changes, since
  // that's the entire point of using a formula instead of a fixed figure.
  assert(cassetteCountPerCore('ISP', 24) === 2, 'a higher-capacity cassette (24 strands/cassette) needs fewer cassettes: ceil(36/24)=2, not fixed at 3');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
