// test-count-leadered-devices.mjs — locks in behavior against 9 real,
// human-counted TR rooms from one production sheet (T-401, VA Gainesville
// EHRM). The bar here is NOT "9/9 correct" -- it's:
//   (a) every room that CAN be resolved from vector geometry resolves to
//       the exact correct count (no wrong numbers, ever), and
//   (b) every room that can't be resolved is flagged, not guessed.
// A confidently-wrong count is a worse failure than a flagged one -- see
// this module's own header for the false-positive this replaced.
// Run: node --test tests/test-count-leadered-devices.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countLeaderedDevices } from '../public/lib/count-leadered-devices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tr-rack-leader-fixture.json'), 'utf8')
);

// Rooms with a lone "TYPICAL" single-leader callout -- confirmed on real
// geometry to need different tuning (elbow-routed leader, or the anchor
// derived from the "2" glyph's own center sits slightly off the true
// leader-fan origin). Named here, not hidden -- this is the honest,
// tracked follow-up from this module's validation.
const KNOWN_NEEDS_TUNING = new Set(['A030A-1', 'C085A-1', 'FB23B-1']);

console.log('Real T-401 rooms (VA Gainesville EHRM), 9 human-counted ground truths:');
let exactMatches = 0;
for (const room of fixture) {
  const result = countLeaderedDevices(room.anchors, room.segments);
  const label = `${room.room}: truth=${room.truth_rack_count} got=${result.total}${result.needsReview ? ' (flagged for review)' : ''}`;

  if (KNOWN_NEEDS_TUNING.has(room.room)) {
    // These are EXPECTED to need review right now (single-leader "TYPICAL"
    // callouts -- see file header). The bar isn't "flagged" specifically --
    // it's "never a confident wrong number". A030A-1 happens to total 1
    // (matching truth) but for an untrustworthy reason (origin 21.5 units
    // from anchor, outside the confirmed-good 11-16 unit range) and is
    // correctly flagged anyway rather than trusted on a coincidence.
    assert(result.needsReview, `${label} -- known open case, flags rather than silently trusting a coincidental/wrong match`);
  } else {
    assert(result.total === room.truth_rack_count && !result.needsReview, label);
    if (result.total === room.truth_rack_count) exactMatches++;
  }
}

console.log(`\n${exactMatches}/${fixture.length - KNOWN_NEEDS_TUNING.size} resolvable rooms matched exactly (excludes ${KNOWN_NEEDS_TUNING.size} known-open single-leader cases)`);

console.log('\nCompound case (EB51A-1: two separate callouts summing to one total):');
{
  const eb51a = fixture.find((r) => r.room === 'EB51A-1');
  const result = countLeaderedDevices(eb51a.anchors, eb51a.segments);
  assert(result.perAnchor.length === 2, 'two anchors produce two per-anchor results');
  assert(result.total === 3, `fanout 2 + fanout 1 sums to 3 (got ${result.total})`);
}

console.log('\nEdge cases:');
{
  const empty = countLeaderedDevices([], []);
  assert(empty.total === 0 && !empty.needsReview, 'zero anchors -> total 0, not flagged (a room can genuinely have no rack callout, e.g. DB97-1)');

  const dbRoom = fixture.find((r) => r.room === 'DB97-1');
  const dbResult = countLeaderedDevices(dbRoom.anchors, dbRoom.segments);
  assert(dbResult.total === 0 && !dbResult.needsReview, 'DB97-1 (true 0 racks, 0 callouts) -> 0, not flagged');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
