// test-normalize-tr-name.mjs — Step 6-support gate: matching a floor-plan
// TR title back to the schedule's tr_number spelling.
// Run: node --test tests/test-normalize-tr-name.mjs
import { resolveTrMatch } from '../public/lib/normalize-tr-name.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

// Real T-500 tr_number spellings for this project (confirmed via Supabase).
const schedule = [
  'A030A-1', 'A132A-1', 'B050C1', 'C085A1', 'C259-1', 'DB97-1',
  'EB51A', 'FB23B-1', 'FB28L-1',
];

console.log('Real confirmed pairs (T-401 title -> T-500 tr_number):');
{
  const cases = [
    ['A030A-1', 'A030A-1', 'exact'],
    ['A132A-1', 'A132A-1', 'exact'],
    ['C259-1',  'C259-1',  'exact'],
    ['DB97-1',  'DB97-1',  'exact'],
    ['FB23B-1', 'FB23B-1', 'exact'],
    ['FB28L-1', 'FB28L-1', 'exact'],
    ['B050C-1', 'B050C1',  'stripped'],       // hyphen only
    ['C085A-1', 'C085A1',  'stripped'],       // hyphen only
    ['EB51A-1', 'EB51A',   'suffix-dropped'], // NOT just a hyphen -- see file header
  ];
  for (const [floorPlan, expected, tier] of cases) {
    const r = resolveTrMatch(floorPlan, schedule);
    assert(r.match === expected, `${floorPlan} -> ${expected} (got ${r.match})`);
    assert(r.tier === tier, `${floorPlan} resolved at tier '${tier}' (got '${r.tier}')`);
  }
}

console.log('Negative / safety cases:');
{
  const noMatch = resolveTrMatch('ZZ999-1', schedule);
  assert(noMatch.match === null && noMatch.tier === 'none', 'no matching room anywhere -> null, flagged, not a guess');

  const ambiguous = resolveTrMatch('C085A-1', [...schedule, 'C-085-A-1']); // contrived: two distinct-looking rows both strip to 'C085A1'
  assert(ambiguous.match === null && /ambiguous/.test(ambiguous.reason), 'two schedule rows stripping to the same key -> ambiguous, not silently picked');

  const empty = resolveTrMatch('', schedule);
  assert(empty.match === null, 'empty floor-plan name -> null, no throw');

  const noSchedule = resolveTrMatch('A030A-1', []);
  assert(noSchedule.match === null, 'empty schedule list -> null, no throw');
}

console.log('Ambiguity capture (row objects, not bare strings):');
{
  // Real shape a caller would actually have -- Supabase rows with ids, so an
  // ambiguous result carries enough to let a human edit or delete a specific
  // row, not just see a name they'd have to go search for.
  const rowObjects = [
    { id: 101, tr_number: 'C085A1' },
    { id: 102, tr_number: 'C-085-A-1' }, // contrived duplicate, same normalized key
    { id: 103, tr_number: 'DB97-1' },
  ];
  const r = resolveTrMatch('C085A-1', rowObjects);
  assert(r.match === null && Array.isArray(r.candidates) && r.candidates.length === 2,
    `ambiguous result carries the actual colliding rows (got ${r.candidates?.length})`);
  assert(r.candidates.every((c) => typeof c === 'object' && 'id' in c),
    'candidates are the original row objects (with id), not just tr_number strings');
  assert(r.candidates.some((c) => c.id === 101) && r.candidates.some((c) => c.id === 102),
    'both colliding row ids (101, 102) are present for a human to act on');

  // A clean (non-ambiguous) match against row objects still returns just the
  // matched tr_number string, same shape as the plain-string case.
  const clean = resolveTrMatch('DB97-1', rowObjects);
  assert(clean.match === 'DB97-1' && clean.tier === 'exact' && !clean.candidates,
    'non-ambiguous match against row objects returns a plain tr_number, no candidates key');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
