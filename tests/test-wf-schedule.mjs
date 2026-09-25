// Gate: WF2 schedule logic on the REAL T-500 text (fixtures/t500-schedule-textitems.json)
// plus the compare step that drives revision review.
import { readFileSync } from 'node:fs';
import { readTrSchedule, diffTrRows, panelsFor } from '../public/lib/wf-schedule.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const items = JSON.parse(readFileSync(new URL('../fixtures/t500-schedule-textitems.json', import.meta.url)));
const list = Array.isArray(items) ? items : items.items || items.textItems;
const r = readTrSchedule(list);
ok(r.found, 'finds the TR termination schedule on the real T-500');
ok(r.rows.length >= 40, `reads the TR rows (${r.rows.length})`);
const a132 = r.rows.find((x) => x.tr_number === 'A132A-1');
ok(a132 && a132.cat6a_terminations === 534 && a132.min_patch_panels === 12 && a132.building === '01' && a132.level === '1', 'A132A-1: bldg 01, level 1, 534 terminations, 12 panels');
ok(r.rows.every((x) => Number.isInteger(x.cat6a_terminations) && Number.isInteger(x.min_patch_panels)), 'every row has whole-number counts');
ok(!r.rows.some((x) => /CAMERA/i.test(x.tr_number)), 'camera schedule on the same sheet is ignored');

// Compare
const saved = [
  { tr_number: 'E261-1', building: '01', level: '2', cat6a_terminations: 328, min_patch_panels: 7 },
  { tr_number: 'B050C-1', building: '01', level: 'B', cat6a_terminations: 102, min_patch_panels: 3 },
  { tr_number: 'OLD-1', building: '01', level: '1', cat6a_terminations: 10, min_patch_panels: 1 },
];
const proposed = [
  { tr_number: 'E261-1', building: '01', level: '2', cat6a_terminations: 352, min_patch_panels: 8 },
  { tr_number: 'B050C1', building: '01', level: 'B', cat6a_terminations: 102, min_patch_panels: 3 },
  { tr_number: 'NEW-1', building: '01', level: '3', cat6a_terminations: 40, min_patch_panels: 1 },
];
const d = diffTrRows(saved, proposed);
ok(d.changed.length === 1 && d.changed[0].diffs.map((x) => x.field).join() === 'cat6a_terminations,min_patch_panels', 'E261-1 328->352 shows as a change to terminations and panels');
ok(d.unchanged.length === 1, 'B050C1 vs B050C-1 is the same room (spelling only), unchanged');
ok(d.added.map((x) => x.tr_number).join() === 'NEW-1' && d.removed.map((x) => x.tr_number).join() === 'OLD-1', 'added and removed TRs detected');
ok(panelsFor(328) === 7 && panelsFor(352) === 8, 'panel math for the plain-words explanation');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
