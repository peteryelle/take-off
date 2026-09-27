// tests/test-wf8-pricing.mjs — WF8 pass 2: assemblies × catalog, parts list, import, template round trip
// Run: node tests/test-wf8-pricing.mjs   (template / workbook checks run when exceljs is installed)
import { priceItems, pricingSummary, partsList, parseImport, buildTemplate, sheetRows, PART_COLS, ASM_COLS } from '../public/lib/wf8-pricing.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

const items = [
  { key: 'wf4:count:2D', item: '2D', unit: 'ea', qty: 100, step: 'WF4' },
  { key: 'wf4:ft:2D', item: '2D cable', unit: 'ft', qty: 12000, step: 'WF4' },
  { key: 'wf6:CN1', item: 'Rack', unit: 'ea', qty: 5, step: 'WF6' },
  { key: 'wf6:CN3-cassette', item: 'Cassettes', unit: 'ea', qty: 12, step: 'WF6' },
  { key: 'wf7:cable:1', item: 'Backbone', unit: 'runs', qty: 6, step: 'WF7' },
];
const parts = [
  { part_number: 'FP-2', description: 'Faceplate 2-port', unit: 'ea', unit_cost: 3.5, labor_min: 2 },
  { part_number: 'JK-6A', description: 'Cat6A jack', unit: 'ea', unit_cost: 7.45, labor_min: 10 },
  { part_number: 'CBL-6A', description: 'Cat6A cable', unit: 'ft', unit_cost: 0.62, labor_min: 0.5 },
  { part_number: 'ORMM2073038-W', description: 'Rack', unit: 'ea', unit_cost: 1920.99, labor_min: 240 },
  { part_number: 'HDX-MTP', description: 'Cassette', unit: 'ea', unit_cost: null, labor_min: 5 },
];
const asm = [
  { item_key: 'wf4:count:2D', part_number: 'FP-2', qty: 1, waste: 1 },
  { item_key: 'wf4:count:2D', part_number: 'JK-6A', qty: 2, waste: 1 },
  { item_key: 'wf4:ft:2D', part_number: 'CBL-6A', qty: 1, waste: 1.05 },
  { item_key: 'wf6:CN1', part_number: 'ORMM2073038-W', qty: 1, waste: 1 },
  { item_key: 'wf6:CN3-cassette', part_number: 'HDX-MTP', qty: 1, waste: 1 },
  { item_key: 'wf6:CN3-cassette', part_number: 'NOT-THERE', qty: 1, waste: 1 },
];
const pr = priceItems(items, asm, parts);
eq('2D outlet = faceplate + 2 jacks', [pr.get('wf4:count:2D').status, pr.get('wf4:count:2D').unit_cost, pr.get('wf4:count:2D').labor_min], ['priced', 18.4, 22]);
eq('cable per ft with 5% waste', [pr.get('wf4:ft:2D').unit_cost, pr.get('wf4:ft:2D').labor_min], [0.651, 0.525]);
eq('rack priced', pr.get('wf6:CN1').unit_cost, 1920.99);
eq('missing price or part -> blank, never $0', [pr.get('wf6:CN3-cassette').status, pr.get('wf6:CN3-cassette').unit_cost, pr.get('wf6:CN3-cassette').missing],
  ['partial', null, ['HDX-MTP (no price)', 'NOT-THERE (not in catalog)']]);
eq('no assembly', [pr.get('wf7:cable:1').status, pr.get('wf7:cable:1').unit_cost], ['none', null]);
eq('summary', pricingSummary(items, pr), { items: 5, priced: 3, partial: 1, none: 1 });

const pl = partsList(items, asm, parts);
eq('parts list totals = item qty × per unit × waste', pl.map((p) => [p.part_number, p.qty]),
  [['CBL-6A', 12600], ['FP-2', 100], ['HDX-MTP', 12], ['JK-6A', 200], ['NOT-THERE', 12], ['ORMM2073038-W', 5]]);
eq('parts list keeps unknown parts visible', pl.find((p) => p.part_number === 'NOT-THERE').part, null);

// import parsing
const partsRows = [PART_COLS,
  ['FP-2', 'Leviton', 'Faceplate', 'ea', '$3.60', '2', '', '', ''],
  ['', '', '', '', '', '', '', '', ''],
  ['JK-6A', 'Leviton', 'Jack', 'ea', 'abc', '', '', '', ''],
  ['FP-2', '', 'dup', 'ea', '1', '', '', '', ''],
  ['NEW-1', '', 'New part', 'ft', '', '', '', '', '']];
const asmRows = [ASM_COLS,
  ['wf4:count:2D', '2D', 'ea', 'FP-2', 1, 1, ''],
  ['wf4:count:2D', '2D', 'ea', 'JK-6A', 2, '', ''],
  ['wf6:CN1', 'Rack', 'ea', '', 1, 1, ''],
  ['wf9:nope', 'x', 'ea', 'FP-2', 1, 1, ''],
  ['wf4:ft:2D', '2D cable', 'ft', 'CBL-6A', 1, 0.9, ''],
  ['wf4:count:2D', '2D', 'ea', 'FP-2', 1, 1, '']];
const r = parseImport({ partsRows, assemblyRows: asmRows }, new Set(items.map((i) => i.key)));
eq('parts parsed ($ and commas ok, blank rows skipped)', r.parts.map((p) => [p.part_number, p.unit_cost, p.labor_min, p.unit]), [['FP-2', 3.6, 2, 'ea'], ['NEW-1', null, null, 'ft']]);
eq('lines parsed; blank slots skipped; waste default 1', r.assemblies.map((a) => [a.item_key, a.part_number, a.qty, a.waste]), [['wf4:count:2D', 'FP-2', 1, 1], ['wf4:count:2D', 'JK-6A', 2, 1]]);
eq('only filled items are replaced', r.replace_items, ['wf4:count:2D']);
eq('errors named by row', r.errors, [
  'Parts row 4: JK-6A unit cost "abc" is not a number', 'Parts row 5: FP-2 appears twice',
  'Assemblies row 5: item "wf9:nope" is not a BOM item of this project', 'Assemblies row 6: waste "0.9" must be 1 or more (1.05 = 5% waste)',
  'Assemblies row 7: FP-2 listed twice for wf4:count:2D']);

// template round trip + workbook prefill (needs exceljs)
let ExcelJS = null;
try { ExcelJS = (await import('exceljs')).default; } catch {}
if (ExcelJS) {
  const tpl = buildTemplate(ExcelJS, items, parts, asm);
  eq('template sheets', tpl.worksheets.map((w) => w.name), ['Read me', 'Parts', 'Assemblies']);
  const buf = await tpl.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook(); await back.xlsx.load(buf);
  const rt = parseImport({ partsRows: sheetRows(back, 'Parts'), assemblyRows: sheetRows(back, 'Assemblies') }, new Set(items.map((i) => i.key)));
  eq('round trip: parts come back', rt.parts.length, 5);
  eq('round trip: all 6 existing lines come back (incl. a part not in the catalog); the blank slot is skipped', rt.assemblies.length, 6);
  eq('round trip: every filled item listed', rt.replace_items.sort(), ['wf4:count:2D', 'wf4:ft:2D', 'wf6:CN1', 'wf6:CN3-cassette']);

  const { buildWorkbook } = await import('../public/lib/wf8-workbook.js');
  const model = { sheets: { tr_schedule: [], rack_bom: { columns: [], rows: [] }, tr_summary: { columns: [], rows: [] },
    summary: [{ key: 'wf6:CN1', item: 'Rack', detail: 'Per new rack', part: 'ORMM2073038-W', ref: 'CN 1', qty: 5, missing: 0 }],
    device_counts: { types: ['2D'], rows: [{ level: 'L1', counts: { '2D': 100 } }] }, lengths: { types: ['2D'], rows: [{ level: 'L1', ft: { '2D': 12000 } }] },
    floor_assemblies: [], ancillary: [], backbone: { rows: [], totals: [] }, allowances: [], notes: [] }, items, sections: [], checks: [] };
  const byKey = Object.fromEntries([...pr.entries()].map(([k, v]) => [k, v]));
  const wb = buildWorkbook(ExcelJS, model, {}, { byKey, margin: 0.1, rate: 100, parts_list: pl });
  const sum = wb.getWorksheet('Summary');
  eq('summary pre-filled from the catalog', [sum.getCell('F2').value, sum.getCell('G2').value, sum.getCell('I2').value, sum.getCell('J2').value], [1920.99, 0.1, 240, 100]);
  const dc = wb.getWorksheet('Device Counts');
  eq('device price row pre-filled', [dc.getCell('B5').value, dc.getCell('B6').value, dc.getCell('B8').value], [18.4, 0.1, 22]);
  eq('parts list sheet added', !!wb.getWorksheet('Parts List'), true);
  const blank = buildWorkbook(ExcelJS, model, {}, null).getWorksheet('Summary');
  eq('without a catalog the cost stays blank', blank.getCell('F2').value, null);
} else console.log('(exceljs not installed — template / workbook checks skipped)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
