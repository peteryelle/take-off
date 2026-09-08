// test-tr-schedule.mjs — Step 4 gate. Pure fixture for the T-500 TR
// termination/hardware schedule. Run: node --test tests/test-tr-schedule.mjs
import { parseTrSchedule } from '../public/lib/tr-schedule.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

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

// Column x-positions matching the real T-500 layout.
const X = { bldg: 0.10, lvl: 0.15, tr: 0.22, term: 0.32, panels: 0.42 };

// Real T-500 rows: deliberately mixed TR-name shapes (hyphenated, bare
// alphanumeric, digit-leading) — the case the validity gate has to handle
// without a TR-name regex.
const ROWS = [
  { bldg: '1', lvl: '5', tr: 'H519-1', term: '288', panels: '6' },
  { bldg: '1', lvl: 'B', tr: 'B050C1', term: '102', panels: '3' },
  { bldg: '1', lvl: 'B', tr: 'EB51A', term: '446', panels: '10' },
  { bldg: '1', lvl: '5', tr: 'E5031', term: '224', panels: '5' },
  { bldg: '12', lvl: '3', tr: '347-12', term: '188', panels: '4' },
];

function t500Items() {
  const items = [ti('TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCHEDULE', X.bldg, 0.05)];

  // Header wraps across TWO lines per real T-500 (confirmed on the
  // Gainesville EHRM sheet) — this is the case schedule.js's single-row
  // headerX cannot handle and headerXBand's wider band exists for.
  items.push(
    ti('BUILDING', X.bldg, 0.08), ti('NUMBER', X.bldg, 0.095),
    ti('LEVEL', X.lvl, 0.08),
    ti('TELECOMMUNICATIONS', X.tr, 0.08), ti('ROOM NUMBER', X.tr, 0.095),
    ti('TOTAL CAT6A CABLE', X.term, 0.08), ti('TERMINATIONS PER TR', X.term, 0.095),
    ti('MINIMUM NUMBER OF PATCH', X.panels, 0.08), ti('PANELS', X.panels, 0.095),
  );

  let y = 0.12;
  for (const r of ROWS) {
    items.push(
      ti(r.bldg, X.bldg, y), ti(r.lvl, X.lvl, y), ti(r.tr, X.tr, y),
      ti(r.term, X.term, y), ti(r.panels, X.panels, y),
    );
    y += 0.015;
  }

  // Footer notes block below the table — must NOT be parsed as data rows.
  items.push(ti('NOTES:', X.bldg, y + 0.02));
  items.push(ti('1. SEE ENLARGED DATA ROOM PLANS FOR TELECOMMUNICATIONS ROOM EQUIPMENT LOCATIONS.', X.bldg, y + 0.035));

  return items;
}

console.log('T-500 TR TERMINATION AND HARDWARE SCHEDULE:');
{
  const rows = parseTrSchedule(t500Items(), cfg);
  assert(rows.length === ROWS.length, `tr_schedule rows == ${ROWS.length} (got ${rows.length})`);
  assert(rows.every((r) => r.tr_number), 'every row carries a tr_number');
  assert(rows.some((r) => r.tr_number === 'B050C1'), 'bare alphanumeric TR name (no hyphen) parses');
  assert(rows.some((r) => r.tr_number === '347-12'), 'digit-leading TR name parses');
  assert(rows.every((r) => Number.isInteger(r.total_terminations)), 'total_terminations is an integer on every row');
  assert(rows.every((r) => Number.isInteger(r.min_patch_panels)), 'min_patch_panels is an integer on every row');
  const h519 = rows.find((r) => r.tr_number === 'H519-1');
  assert(h519 && h519.total_terminations === 288 && h519.min_patch_panels === 6, 'H519-1 values match source (288 / 6)');
  assert(rows.every((r) => !/NOTES|ENLARGED/.test(r.tr_number)), 'footer notes block excluded from rows');
}

console.log('Edge cases:');
{
  assert(parseTrSchedule([], { present: false }).length === 0, 'present:false -> []');
  assert(parseTrSchedule(t500Items(), { ...cfg, locator: "table titled 'NONEXISTENT'" }).length === 0,
    'locator title not found -> [] (graceful, no throw)');
  assert(parseTrSchedule(t500Items(), { present: true, columns: {} }).length === 0,
    'missing required column config -> [] (graceful, no throw)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
