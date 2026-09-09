// test-tr-schedule.mjs — Step 4 gate. Uses REAL text extracted from an
// actual T-500 sheet (Gainesville EHRM), not a hand-built fixture — a
// synthetic fixture twice encoded wrong assumptions (uniform 2-line header
// wrapping; header text x-aligned with its data column) that only real data
// caught. See fixtures/t500-schedule-textitems.json and tr-schedule.js's
// file header for what those assumptions got wrong and how this reader
// avoids depending on them: positional column assignment (left-to-right
// order within each row) instead of nearest-header-x.
//
// Run: node --test tests/test-tr-schedule.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const cfg = {
  present: true,
  locator: "table titled 'TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCHEDULE'",
  columns: {
    building: 'BUILDING NUMBER',
    level: 'LEVEL',
    tr_number: 'TELECOMMUNICATIONS ROOM NUMBER',
    terminations: 'TOTAL CAT6A CABLE TERMINATIONS PER TR',
    patch_panels: 'MINIMUM NUMBER OF PATCH PANELS',
  },
};

console.log('T-500 TR TERMINATION AND HARDWARE SCHEDULE (real sheet):');
{
  const rows = parseTrSchedule(realItems, cfg);

  // Locked to the sheet's actual row count — verified by hand against the
  // source table (44 TRs). A regression here means the header/data-offset
  // or dense-line-pitch handling broke again.
  assert(rows.length === 44, `44 real TR rows parsed (got ${rows.length})`);

  assert(rows.every((r) => r.tr_number), 'every row carries a tr_number');
  assert(rows.every((r) => Number.isInteger(r.total_terminations)), 'total_terminations is an integer on every row');
  assert(rows.every((r) => Number.isInteger(r.min_patch_panels)), 'min_patch_panels is an integer on every row');

  // Mixed TR-name shapes really do all appear on this one sheet — the case
  // the validity gate has to handle without a TR-name regex.
  assert(rows.some((r) => r.tr_number === 'B050C1'), 'bare alphanumeric TR name (no hyphen) parses');
  assert(rows.some((r) => r.tr_number === '347-12'), 'digit-leading TR name parses');
  assert(rows.some((r) => r.tr_number === 'E5031'), 'bare alphanumeric TR name (letter+digits, no hyphen) parses');

  // Spot-check against the source table, first row / last row / a middle row
  // with the near-tie column boundary that the old nearest-header-x
  // approach actually got wrong (terminations vs. patch_panels, ~0.0002
  // normalized-x apart from the midpoint on this sheet).
  const first = rows.find((r) => r.tr_number === '110-12');
  assert(first && first.building === '12' && first.level === '1'
    && first.total_terminations === 116 && first.min_patch_panels === 3,
    "110-12 (first row) matches source: bldg 12, lvl 1, 116 terms, 3 panels");

  const last = rows.find((r) => r.tr_number === 'J427-1');
  assert(last && last.building === '01' && last.level === '4'
    && last.total_terminations === 306 && last.min_patch_panels === 7,
    "J427-1 (last row) matches source: bldg 01, lvl 4, 306 terms, 7 panels");

  const h519 = rows.find((r) => r.tr_number === 'H519-1');
  assert(h519 && h519.total_terminations === 288 && h519.min_patch_panels === 6,
    "H519-1 matches source: 288 terms, 6 panels");

  // The sheet's other table (Camera Schedule) and the footer notes block
  // must not leak into the results.
  assert(!rows.some((r) => /CAMERA|NOTES|ENLARGED/i.test(r.tr_number)),
    'Camera Schedule and footer notes excluded from rows');
  assert(rows.every((r) => r.total_terminations < 1000 && r.min_patch_panels < 100),
    'no row absorbed stray text into a numeric column (sanity bound)');
}

console.log('Edge cases:');
{
  assert(parseTrSchedule([], { present: false }).length === 0, 'present:false -> []');
  assert(parseTrSchedule(realItems, { ...cfg, locator: "table titled 'NONEXISTENT'" }).length === 0,
    'locator title not found -> [] (graceful, no throw)');
  assert(parseTrSchedule(realItems, { present: true, columns: {} }).length === 0,
    'missing required column config -> [] (graceful, no throw)');

  // tolerances belong on the config (per-AE, Discovery-calibrated), not
  // hardcoded -- confirm the config path actually wins over both opts and
  // the built-in defaults, so a future AE's calibrated numbers really apply.
  const cfgWithTol = { ...cfg, tolerances: { rowTol: 0.010, colTol: 0.012, headerBandTol: 0.010 } };
  const viaConfig = parseTrSchedule(realItems, cfgWithTol);
  assert(viaConfig.length === 44, `config-supplied tolerances still parse all 44 rows (got ${viaConfig.length})`);

  const cfgBadTol = { ...cfg, tolerances: { colTol: 0.0001 } }; // absurdly tight -> columns fail to join
  const viaBadConfig = parseTrSchedule(realItems, cfgBadTol, { colTol: 0.012 });
  assert(viaBadConfig.length === 0,
    'config.tolerances overrides opts, even to a value that breaks parsing (priority order confirmed)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
