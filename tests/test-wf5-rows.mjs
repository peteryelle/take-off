// tests/test-wf5-rows.mjs — WF5 TR rooms manual grid (pure logic)
// Run: node tests/test-wf5-rows.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CATEGORIES, parseCell, buildRows, rowDirty, changedCells, validateCells, applyBulk, summary,
  feetPerInchFromLabel, sheetScale, polylineFeet } from '../public/lib/wf5-rows.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

// columns match the takeoff.tr_room_devices CHECK
eq('ten columns', CATEGORIES, ['rack_new', 'rack_existing', 'wire_manager', 'access_control', 'backboard',
  'cable_tray', 'camera_connection', 'ground_busbar', 'motion_sensor', 'sleeves']);

// parseCell
eq('blank -> null', parseCell('rack_new', ''), null);
eq('spaces -> null', parseCell('rack_new', '  '), null);
eq('zero is a value', parseCell('rack_new', '0'), 0);
eq('count', parseCell('rack_new', '3'), 3);
eq('count rejects decimals', parseCell('rack_new', '2.5'), undefined);
eq('rejects negative', parseCell('sleeves', '-1'), undefined);
eq('rejects text', parseCell('sleeves', 'abc'), undefined);
eq('tray feet one decimal', parseCell('cable_tray', '42.46'), 42.5);
eq('tray feet integer ok', parseCell('cable_tray', '40'), 40);

// buildRows
const trs = [{ id: 2, tr_number: 'EB51A-1' }, { id: 1, tr_number: 'A030A-1' }, { id: 3, tr_number: null }, { id: 4, tr_number: 'FB28L-1' }];
const values = [
  { tr_name: 'A030A-1', category: 'rack_new', quantity: '2' },
  { tr_name: 'A030A-1', category: 'cable_tray', quantity: 38.5 },
  { tr_name: 'EB51A-1', category: 'rack_new', quantity: 3 },
  { tr_name: 'EB51A-1', category: 'sleeves', quantity: 0 },
];
const marks = [{ tr_name: 'EB51A-1', page_id: 7, x_norm: 0.2, y_norm: 0.3 }, { tr_name: 'FB28L-1', page_id: 7, x_norm: 0.7, y_norm: 0.4 }];
let rows = buildRows(trs, values, marks);
eq('rows sorted, TRs without a number dropped', rows.map((r) => r.tr_name), ['A030A-1', 'EB51A-1', 'FB28L-1']);
eq('numeric quantity', rows[0].saved.rack_new, 2);
eq('blank stays null', rows[0].saved.sleeves, null);
eq('zero stays zero', rows[1].saved.sleeves, 0);
eq('mark attached', rows[1].mark.page_id, 7);
eq('tr_id carried', rows.map((r) => r.tr_id), [1, 2, 4]);
eq('fresh rows not dirty', rows.some(rowDirty), false);

// edits -> changed cells
rows[0].counts.rack_new = 3; rows[0].edit_page_id = 7; rows[0].edit_basis = 'Entered from sheet T-401';
rows[1].counts.sleeves = null;                 // clear a zero -> delete
eq('dirty rows', rows.filter(rowDirty).map((r) => r.tr_name), ['A030A-1', 'EB51A-1']);
eq('changed cells', changedCells(rows), [
  { tr_name: 'A030A-1', category: 'rack_new', quantity: 3, page_id: 7, basis: 'Entered from sheet T-401' },
  { tr_name: 'EB51A-1', category: 'sleeves', quantity: null, page_id: null, basis: null },
]);

// validateCells (server side)
const names = rows.map((r) => r.tr_name);
let v = validateCells([{ tr_name: 'A030A-1', category: 'cable_tray', quantity: '12.34' }, { tr_name: 'FB28L-1', category: 'rack_new', quantity: null }], names);
eq('valid cells normalised', v, { cells: [{ tr_name: 'A030A-1', category: 'cable_tray', quantity: 12.3 }, { tr_name: 'FB28L-1', category: 'rack_new', quantity: null }], errors: [] });
v = validateCells([{ tr_name: 'ZZZ', category: 'rack_new', quantity: 1 }], names);
eq('unknown TR rejected', v.errors.length, 1);
v = validateCells([{ tr_name: 'A030A-1', category: 'patch_panel', quantity: 1 }], names);
eq('unknown column rejected', v.errors.length, 1);
v = validateCells([{ tr_name: 'A030A-1', category: 'rack_new', quantity: 1.5 }], names);
eq('fractional count rejected', v.errors.length, 1);
v = validateCells([{ tr_name: 'A030A-1', category: 'rack_new', quantity: 1 }, { tr_name: 'A030A-1', category: 'rack_new', quantity: 2 }], names);
eq('duplicate cell rejected', v.errors.length, 1);

// bulk
rows = buildRows(trs, values, marks);
rows[0].checked = true; rows[2].checked = true;
eq('bulk on checked', applyBulk(rows, 'backboard', 1), 2);
eq('bulk values', rows.map((r) => r.counts.backboard), [1, null, 1]);
eq('bulk all', applyBulk(rows, 'ground_busbar', 1, () => true), 3);
eq('bulk blank clears', (applyBulk(rows, 'backboard', null), rows.map((r) => r.counts.backboard)), [null, null, null]);

// summary
rows = buildRows(trs, values, marks);
eq('summary', summary(rows), { rooms: 3, done: 2, with_values: 2, done_empty: 1, values_not_done: 1, unsaved: 0, racks_new: 5, tray_ft: 38.5 });

// scale labels
eq('1/2 -> 2 ft/in', feetPerInchFromLabel(`1/2" = 1'-0"`), 2);
eq('1/8 -> 8', feetPerInchFromLabel(`1/8" = 1'-0"`), 8);
eq('3/16 -> 5.3333', feetPerInchFromLabel(`3/16" = 1'-0"`), 5.3333);
eq('1-1/2 -> 0.6667', feetPerInchFromLabel(`1-1/2" = 1'-0"`), 0.6667);
eq('1 -> 1', feetPerInchFromLabel(`1" = 1'-0"`), 1);
eq('curly quotes', feetPerInchFromLabel('1/4” = 1’-0”'), 4);
eq('not a scale', feetPerInchFromLabel('NTS'), null);

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/wf5-room-sheet-text.json'), 'utf8'));
const s401 = sheetScale(fx['T-401']), s407 = sheetScale(fx['T-407']);
eq('T-401 scale read from sheet', s401 && s401.ft_per_inch, 2);
eq('T-401 has a label per view (9 views + bar)', s401 && s401.count >= 9, true);
eq('T-407 scale read from sheet', s407 && s407.ft_per_inch, 2);
eq('no labels -> null', sheetScale('ENLARGED DATA ROOMS NTS'), null);

// measure length: 1/2" = 1'-0" -> 36 pt per foot
eq('polyline 36pt = 1 ft', polylineFeet([[0, 0], [36, 0]], 2), 1);
eq('polyline L-shape', polylineFeet([[0, 0], [360, 0], [360, 180]], 2), 15);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
