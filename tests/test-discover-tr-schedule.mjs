// test-discover-tr-schedule.mjs — Step 6-equivalent gate for tr_summary
// tables: proposes a full pages.tr_schedule config (locator + columns +
// tolerances) from a page's raw text_items alone, no human input, no LLM.
//
// Uses the same real T-500 extraction as test-tr-schedule.mjs (see that
// file and tr-schedule.js's header for what a hand-built fixture got wrong
// twice — this reuses real ground truth rather than risk a third guess).
//
// Run: node --test tests/test-discover-tr-schedule.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { proposeTrScheduleConfig } from '../public/lib/discover-tr-schedule.js';
import { parseTrSchedule } from '../public/lib/tr-schedule.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const realItems = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 't500-schedule-textitems.json'), 'utf8')
);

console.log('T-500: propose full config from raw text_items alone (no hints)');
{
  const result = proposeTrScheduleConfig(realItems);

  assert(result.config !== null, 'a config was proposed (not null / not ambiguous)');
  assert(result.config?.present === true, 'proposed config has present:true');
  assert(result.config?.locator?.includes('TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCHEDULE'),
    `locator matches the real title (got ${result.config?.locator})`);

  const c = result.config?.columns || {};
  assert(c.tr_number === 'TELECOMMUNICATIONS ROOM NUMBER', `tr_number column mapped correctly (got ${c.tr_number})`);
  assert(c.terminations === 'TOTAL CAT6A CABLE TERMINATIONS PER TR', `terminations column mapped correctly (got ${c.terminations})`);
  assert(c.patch_panels === 'MINIMUM NUMBER OF PATCH PANELS', `patch_panels column mapped correctly (got ${c.patch_panels})`);
  assert(c.building === 'BUILDING NUMBER', `building column mapped correctly (got ${c.building})`);
  assert(c.level === 'LEVEL', `level column mapped correctly (got ${c.level})`);

  assert(typeof result.config?.tolerances?.rowTol === 'number', 'tolerances.rowTol was calibrated (a number, not hand-set)');
  assert(typeof result.config?.tolerances?.colTol === 'number', 'tolerances.colTol was calibrated');
  assert(typeof result.config?.tolerances?.headerBandTol === 'number', 'tolerances.headerBandTol was calibrated');

  console.log('T-500: the sheet\'s OTHER table (Camera Schedule) must not win');
  const cameraCandidate = result.candidates.find((c2) => c2.title === 'CAMERA SCHEDULE');
  assert(cameraCandidate && cameraCandidate.archetype !== 'tr_summary',
    `Camera Schedule classifies as ${cameraCandidate?.archetype}, not tr_summary`);

  console.log('End-to-end: the auto-discovered config actually parses correctly');
  const rows = parseTrSchedule(realItems, result.config);
  // The real, verified row count for this sheet -- see test-tr-schedule.mjs
  // for how the OLD hand-tuned default (rowTol:0.010) silently dropped the
  // true last row (J527-1) by merging it with the footer notes line 0.0093
  // below it. Discovery's calibrated rowTol doesn't have that problem because
  // it's measured from this sheet's own real row gaps, not guessed.
  assert(rows.length === 45, `auto-discovered config parses all 45 real rows (got ${rows.length})`);
  assert(rows.some((r) => r.tr_number === 'J527-1'),
    'the true last row (J527-1) is present -- proves calibration beats the old hand-tuned default, not just matches it');
}

console.log('Edge cases:');
{
  assert(proposeTrScheduleConfig([]).config === null, 'empty page -> no config (not a throw, not a guess)');

  const noScheduleWord = [{ str: 'RANDOM TABLE', cx_norm: 0.5, cy_norm: 0.1 }];
  assert(proposeTrScheduleConfig(noScheduleWord).config === null,
    'a table with no "...SCHEDULE" title -> no candidate found');

  // Two tr_summary-shaped tables on one page -> ambiguous, must not guess.
  const twoWinners = [
    { str: 'ROOM SCHEDULE', cx_norm: 0.2, cy_norm: 0.05 },
    { str: 'ROOM NUMBER', cx_norm: 0.15, cy_norm: 0.10 }, { str: 'TERMINATIONS', cx_norm: 0.25, cy_norm: 0.10 },
    { str: '101', cx_norm: 0.15, cy_norm: 0.12 }, { str: '5', cx_norm: 0.25, cy_norm: 0.12 },
    { str: 'PATCH PANELS', cx_norm: 0.35, cy_norm: 0.10 }, { str: '2', cx_norm: 0.35, cy_norm: 0.12 },
    { str: 'OTHER ROOM SCHEDULE', cx_norm: 0.7, cy_norm: 0.05 },
    { str: 'ROOM NUMBER', cx_norm: 0.65, cy_norm: 0.10 }, { str: 'TERMINATIONS', cx_norm: 0.75, cy_norm: 0.10 },
    { str: '201', cx_norm: 0.65, cy_norm: 0.12 }, { str: '9', cx_norm: 0.75, cy_norm: 0.12 },
    { str: 'PATCH PANELS', cx_norm: 0.85, cy_norm: 0.10 }, { str: '3', cx_norm: 0.85, cy_norm: 0.12 },
  ];
  const ambiguous = proposeTrScheduleConfig(twoWinners);
  assert(ambiguous.config === null && ambiguous.reasons.some((r) => /ambiguous/.test(r)),
    'two tr_summary-shaped tables on one page -> ambiguous, no config guessed');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
