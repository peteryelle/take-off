// tests/test-wf8-bom.mjs — WF8 BOM model (and the workbook, when exceljs is installed)
// Run: node tests/test-wf8-bom.mjs
// Inputs are built from the real rack-sheet and riser-sheet fixtures plus a small TR list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { linesFromTextContent, readDrawingNotes, readElevations, suggestRules } from '../public/lib/wf6-rules.js';
import { parseCodedNotes } from '../public/lib/parse-coded-notes.js';
import { readRiserBlocks, readCableNotes, readHeadEnd, readAllowances, matchRiserTr } from '../public/lib/wf7-riser.js';
import { buildBom, diffItems, revisionChanges, causeFor, SHEETS } from '../public/lib/wf8-bom.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};
const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(here, '../fixtures', f), 'utf8'));

function inputs({ confirmAll = true } = {}) {
  const f6 = fx('wf6-rack-sheet-textcontent.json')['T-501'];
  const runs6 = linesFromTextContent(f6.items, f6.width, f6.height);
  const rules = suggestRules(parseCodedNotes(runs6), readDrawingNotes(runs6));
  const set = (k, p, v) => { rules.find((r) => r.rule_key === k).params[p] = { v, source: 'user' }; };
  set('CN3-cassette', 'fibers_per_cassette', 12); set('CN7', 'ports_per_switch', 48); set('CN6', 'each', 1); set('CN9', 'each', 0.5);
  set('CN5', 'switch_ru', 1); set('CN5', 'power_ru_per_rack', 6);
  rules.forEach((r) => { r.source = 'extracted'; if (confirmAll) r.confirmed_at = 't'; });
  const f7 = fx('wf7-riser-sheet-textcontent.json')['T-601'];
  const runs7 = linesFromTextContent(f7.items, f7.width, f7.height, { maxMergeFrac: 0.5 });
  const names = ['A502-1', 'EB51A', 'C259-1', 'DB97-1'];
  const cables = readCableNotes(runs7).map((c) => ({ ...c, confirmed_at: 't' }));
  const feeds = readRiserBlocks(runs7).map((b) => { const m = matchRiserTr(b.tr_name_read, names);
    return { ...b, tr_name: m.kind === 'none' ? null : m.tr_name, match_kind: m.kind === 'none' ? null : m.kind, confirmed_at: m.kind === 'none' ? null : 't' }; });
  const allowances = readAllowances(runs7).flatMap((g) => g.lines).map((a) => ({ ...a, confirmed_at: 't', source: 'extracted' }));
  const trs = [
    { tr_number: 'A502-1', building: '01', level: '5', cat6a_terminations: 116, min_patch_panels: 3, source: 'extracted' },
    { tr_number: 'EB51A', building: '01', level: 'B', cat6a_terminations: 620, min_patch_panels: 14, source: 'extracted' },
    { tr_number: 'C259-1', building: '01', level: '1', cat6a_terminations: 336, min_patch_panels: 7, source: 'extracted' },
    { tr_number: 'DB97-1', building: '01', level: 'B', cat6a_terminations: 60, min_patch_panels: 2, source: 'extracted' },
  ];
  const room = [];
  for (const [tr, n] of [['A502-1', 1], ['EB51A', 3], ['C259-1', 1], ['DB97-1', 0]]) {
    room.push({ tr_name: tr, category: 'rack_new', quantity: n, source: 'manual', override_basis: 'Entered from sheet X' });
    room.push({ tr_name: tr, category: 'backboard', quantity: 1, source: 'manual', override_basis: 'Entered from sheet X' });
    room.push({ tr_name: tr, category: 'cable_tray', quantity: 20.5, source: 'manual', override_basis: 'Entered from sheet X' });
  }
  room.push({ tr_name: 'DB97-1', category: 'rack_existing', quantity: 2, source: 'manual', override_basis: 'Entered from sheet X' });
  const rollup = { types: ['2D', 'WAP'], totals: { no_length: 1 },
    by_level: [{ level: 'L1', by_type: { '2D': 100, WAP: 10 }, cable_by_type: { '2D': 12000, WAP: 1500.25 }, no_length: 1 }],
    by_tr: [{ tr_name: 'A502-1', by_type: { '2D': 58 } }, { tr_name: 'C259-1', by_type: { '2D': 42, WAP: 10 } }],
    routing_used: [{ mode: 'straight', multiplier: 1.35, devices: 110 }] };
  return { steps: { WF2: 'confirmed', WF4: 'in_review', WF5: 'confirmed', WF6: 'confirmed', WF7: 'confirmed' }, trs, room,
    wf4: { rollup, types: [{ name: '2D', ports: 2 }, { name: 'WAP', ports: null }] },
    wf6: { rules, elevations: readElevations(runs6) }, wf7: { feeds, cables, allowances, head_end: readHeadEnd(runs7), wf3_ends: [] } };
}

const m = buildBom(inputs());
eq('all workbook sheets + 2 new', m.sections.map((s) => s.name), SHEETS.map((s) => s.name));
eq('Backbone and Allowances sheets exist', ['Backbone', 'Allowances'].every((n) => SHEETS.some((s) => s.name === n)), true);
eq('readiness follows step status', m.sections.filter((s) => s.status !== 'ready').map((s) => `${s.name}:${s.status}`),
  ['Device Counts:waiting', 'Lengths, by Device:waiting', 'Floor Assemblies:waiting', 'Notes & Assumptions:written']);

// TR schedule
eq('TR schedule carries WF5 racks and WF7 type', m.sheets.tr_schedule.map((t) => [t.tr, t.racks_new, t.isp_osp]),
  [['A502-1', 1, 'osp'], ['C259-1', 1, 'osp'], ['DB97-1', 0, null], ['EB51A', 3, 'osp']]);

// rack items: one row per new rack, splits from WF6 rules
eq('rack rows', m.sheets.rack_bom.rows.map((r) => r.rack_id), ['A502-1-1', 'C259-1-1', 'EB51A-1', 'EB51A-2', 'EB51A-3']);
const eb = m.sheets.rack_bom.rows.filter((r) => r.tr === 'EB51A');
eq('panels split per rack (14 over 3)', eb.map((r) => r.cells.CN4), [5, 5, 4]);
eq('switches split per rack (620/48 = 13 over 3)', eb.map((r) => r.cells.CN7), [5, 4, 4]);
eq('one rack per row', eb.map((r) => r.cells.CN1), [1, 1, 1]);
const S = Object.fromEntries(m.sheets.summary.map((s) => [s.ref + (s.key.includes('cassette') ? 'c' : ''), s.qty]));
// panels/switches come from the schedule for every TR, incl. DB97-1 with no new racks (2 panels, ceil(60/48)=2 switches)
eq('summary totals from confirmed rules', [S['CN 1'], S['CN 2'], S['CN 4'], S['CN 7']], [5, 8, 26, 25]);
eq('install-only flagged', m.sheets.summary.find((s) => s.ref === 'CN 7').install_only, true);

// unconfirmed rules are not applied
const m2 = buildBom(inputs({ confirmAll: false }));
eq('no confirmed rules -> racks listed (from WF5) with no rule columns, nothing in Summary', [m2.sheets.rack_bom.rows.length, m2.sheets.rack_bom.columns.length, m2.sheets.summary.length], [5, 0, 0]);
eq('rack sheets to review', m2.sections.find((s) => s.key === 'summary').status, 'no data');
eq('unconfirmed counted in checks', m2.checks.find((c) => c.name.startsWith('Items not confirmed')).ok, false);

// WF4, WF5, WF7
eq('device counts by level', m.sheets.device_counts.rows, [{ level: 'L1', counts: { '2D': 100, WAP: 10 } }]);
eq('lengths by level', m.sheets.lengths.rows[0].ft, { '2D': 12000, WAP: 1500.3 });
eq('floor assemblies: jacks = outlets x ports, blank when ports unknown', m.sheets.floor_assemblies, [
  { type: '2D', ports: 2, faceplates: 100, jacks: 200 }, { type: 'WAP', ports: null, faceplates: 10, jacks: null }]);
eq('ancillary from room values', m.sheets.ancillary.map((a) => [a.category, a.qty, a.unit]), [['rack_existing', 2, 'ea'], ['backboard', 4, 'ea'], ['cable_tray', 82, 'ft']]);
eq('backbone rows = confirmed feeds', m.sheets.backbone.rows.map((b) => b.tr), ['A502-1', 'C259-1', 'EB51A']);
eq('backbone totals by cable', m.sheets.backbone.totals.map((t) => [t.note_number, t.cores]), [[1, 6]]);
eq('allowance lines', m.sheets.allowances.length, 8);

// checks and notes
const chk = (n) => m.checks.find((c) => c.name.startsWith(n));
eq('ports vs terminations', [chk('Ports per TR').ok, chk('Ports per TR').detail], [false, 'C259-1 -252']);
eq('capacity check', chk('Terminations vs rack').detail, 'C259-1: 336 outlets > 288 on 1 rack');
eq('schedule TRs without a feed', chk('Schedule TRs with').detail, 'DB97-1');
eq('head end ok', chk('Head end').ok, true);
const topics = m.sheets.notes.map((n) => n.topic);
eq('notes include user-set values', topics.filter((t) => t.startsWith('Set by user')).length, 6);
eq('notes include not-ready sheets', topics.filter((t) => t.startsWith('Sheet not ready')).length, 3);
eq('notes include ports not set', topics.includes('Ports per outlet'), true);
eq('notes include routing', m.sheets.notes.find((n) => n.topic === 'Cable routing').text, 'straight × 1.35 for 110 device(s).');
eq('no sheet numbers baked in', JSON.stringify(m.sections).includes('T-501'), false);

// snapshot items and change orders
eq('items have keys and steps', m.items.every((i) => i.key && i.step && Number.isFinite(i.qty)), true);
const ref = m.items;
const cur = ref.map((i) => (i.key === 'wf6:CN4' ? { ...i, qty: i.qty + 1 } : i)).filter((i) => i.key !== 'wf5:backboard');
cur.push({ key: 'wf4:count:4D', item: '4D', unit: 'ea', qty: 6, step: 'WF4' });
const lines = diffItems(ref, cur);
eq('diff lines', lines.map((l) => [l.key, l.line_type, l.delta]), [['wf4:count:4D', 'add', 6], ['wf5:backboard', 'credit', -4], ['wf6:CN4', 'add', 1]]);
const changes = revisionChanges({ 'T-500': { rev: 'Rev.0', step: 'WF2' }, 'T1.3.D': { rev: 'Rev.0', step: 'WF4' } },
  { 'T-500': { rev: 'Rev.0', step: 'WF2' }, 'T1.3.D': { rev: 'Rev.2', step: 'WF4' }, 'T-601': { rev: 'Rev.1', step: 'WF7' } });
eq('revision changes', changes, [{ sheet: 'T1.3.D', step: 'WF4', from: 'Rev.0', to: 'Rev.2' }, { sheet: 'T-601', step: 'WF7', from: null, to: 'Rev.1' }]);
eq('cause from a revision', causeFor(lines[0], changes), { cause_kind: 'revision', cause_note: 'T1.3.D Rev.0 → Rev.2' });
eq('cause without a revision', causeFor(lines[2], changes), { cause_kind: 'manual', cause_note: 'WF6 data changed (no sheet revision changed)' });

// workbook (only when exceljs is installed: npm i -D exceljs)
let ExcelJS = null;
try { ExcelJS = (await import('exceljs')).default; } catch {}
if (ExcelJS) {
  const { buildWorkbook, buildCoWorkbook } = await import('../public/lib/wf8-workbook.js');
  const wb = buildWorkbook(ExcelJS, m, { label: 'test' });
  eq('workbook sheets', wb.worksheets.map((w) => w.name), SHEETS.map((s) => s.name));
  const sum = wb.getWorksheet('Summary');
  eq('summary qty is a value', typeof sum.getCell('D2').value, 'number');
  eq('sell price is a formula', sum.getCell('H2').value.formula, 'IFERROR(IF(OR(F2="",G2=""),"",F2/(1-G2)),"")');
  const co = buildCoWorkbook(ExcelJS, { number: 'CO-01', lines: lines.map((l) => ({ ...l, cause_note: 'x' })) });
  eq('co delta formula', co.getWorksheet('Change Order').getCell('F2').value.formula, 'E2-D2');
} else console.log('(exceljs not installed — workbook checks skipped)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
