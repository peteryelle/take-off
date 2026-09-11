// test-rack-orchestration.mjs — gate for rack-orchestration.js. Uses the
// SAME real hand-verified truth_rack_count values from
// fixtures/tr-rack-leader-fixture.json (Gainesville EHRM, confirmed against
// actual T-401 sheet geometry) paired with the actual T-500 schedule figures
// for those same rooms — not synthetic numbers. scheduleRow.rack_count here
// stands in for whatever tr-room-review.html's Save button already wrote.
//
// Run: node --test tests/test-rack-orchestration.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sizeTrRacks } from '../public/lib/rack-orchestration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const leaderFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tr-rack-leader-fixture.json'), 'utf8')
);
const truthByRoom = new Map(leaderFixture.map((r) => [r.room, r.truth_rack_count]));

const T500_PANELS = {
  'B050C-1': 3, 'C085A-1': 3, 'EB51A-1': 10,
  'FB23B-1': 3, 'A132A-1': 12, 'C259-1': 8, 'FB28L-1': 2, 'DB97-1': 7,
};

console.log('sizeTrRacks — gating on rack_count being null (unconfirmed):');
{
  const unconfirmed = sizeTrRacks({ tr_number: 'EB51A-1', min_patch_panels: 10, rack_count: null }, null);
  assert(unconfirmed.sized === false && /not confirmed/.test(unconfirmed.reason),
    'null rack_count refuses to size, regardless of anything else on the row');
}

console.log('\nsizeTrRacks — real fixture rooms, confirmed rack_count, no fiber yet:');
for (const room of ['B050C-1', 'C085A-1', 'EB51A-1', 'FB23B-1', 'A132A-1', 'C259-1', 'FB28L-1', 'DB97-1']) {
  const rackCount = truthByRoom.get(room);
  const scheduleRow = { tr_number: room, min_patch_panels: T500_PANELS[room], rack_count: rackCount };
  const result = sizeTrRacks(scheduleRow, null);

  assert(result.sized === true, `${room}: confirmed rack_count sizes successfully`);
  assert(result.rack_count === rackCount, `${room}: rack_count matches fixture truth (${rackCount})`);
  assert(result.fiber_cassette_count === null && result.fiber_pending === true,
    `${room}: no fiber config yet -> cassette count null, fiber_pending true`);

  if (rackCount > 0) {
    const sumPanels = result.patch_panel_distribution.reduce((a, b) => a + b, 0);
    assert(result.patch_panel_distribution.length === rackCount,
      `${room}: panel distribution has one entry per rack (${rackCount})`);
    assert(sumPanels === T500_PANELS[room],
      `${room}: distributed panels sum to the schedule's total (${T500_PANELS[room]})`);
    assert(result.sidecar_count === rackCount + 1,
      `${room}: sidecars = rack_count + 1 (${rackCount + 1})`);
  } else {
    assert(result.patch_panel_distribution.length === 0 && result.sidecar_count === 0,
      `${room}: zero confirmed racks -> zero panels/sidecars (existing-only room, e.g. DB97-1)`);
  }
}

console.log('\nsizeTrRacks — fiber known (project_fiber_config parsed):');
{
  const scheduleRow = { tr_number: 'EB51A-1', min_patch_panels: 10, rack_count: 3 };
  const result = sizeTrRacks(scheduleRow, 'ISP');
  assert(result.fiber_pending === false, 'fiber_pending flips false once plantType is supplied');
  assert(result.fiber_cassette_count === 6, 'ISP cassette count: 3 per core x 2 cores = 6 (rack-assembly-rules.js math)');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
