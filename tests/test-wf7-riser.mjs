// tests/test-wf7-riser.mjs — WF7 riser read from the riser diagram sheet
// Run: node tests/test-wf7-riser.mjs
// Fixture: real pdf.js 3.11.174 getTextContent() of the EHRM riser diagram sheet.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { linesFromTextContent } from '../public/lib/wf6-rules.js';
import { readRiserBlocks, readCableNotes, readHeadEnd, readAllowances, matchRiserTr, reconcile, feedType, feedBlocker,
  cableBlocker, allowanceBlocker, headEndCheck } from '../public/lib/wf7-riser.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/wf7-riser-sheet-textcontent.json'), 'utf8'))['T-601'];
const runs = linesFromTextContent(fx.items, fx.width, fx.height, { maxMergeFrac: 0.5 });

// riser blocks
const blocks = readRiserBlocks(runs);
eq('61 TR blocks (the SSTV diagram rack is not one)', blocks.length, 61);
eq('keys unique', new Set(blocks.map((b) => b.riser_key)).size, 61);
const B = (k) => blocks.find((b) => b.riser_key === k);
eq('A502-1', [B('BLDG 01 | TR A502-1').floor, B('BLDG 01 | TR A502-1').tr_name_read, B('BLDG 01 | TR A502-1').core_a_note, B('BLDG 01 | TR A502-1').core_b_note], ['FIFTH FLOOR', 'A502-1', 1, 1]);
eq('two-line floor joined', [B('BLDG 01 | TR A030A-1').floor, B('BLDG 01 | TR A210-1').floor], ['BASEMENT LEVEL', 'SECOND FLOOR']);
eq('ER 106 fed by note 2', [B('BLDG 43 | ER 106').riser_label, B('BLDG 43 | ER 106').core_a_note, B('BLDG 43 | ER 106').core_b_note], ['ER 106', 2, 2]);
eq('garage has no TR number', [B('LIBERTY GARAGE | TR').tr_name_read, B('LIBERTY GARAGE | TR').building], [null, 'LIBERTY GARAGE']);
eq('every block has a floor and both core notes', blocks.filter((b) => !b.floor || b.core_a_note == null || b.core_b_note == null).length, 0);
eq('60 note-1 feeds, 1 note-2', [blocks.filter((b) => b.core_a_note === 1).length, blocks.filter((b) => b.core_a_note === 2).length], [60, 1]);
eq('no sheet numbers in keys', blocks.every((b) => !/T-\d{3}/.test(b.riser_key)), true);

// cable types
const cables = readCableNotes(runs);
eq('4 cable notes', cables.map((c) => c.note_number), [1, 2, 3, 4]);
eq('note 1 = 24 OS2, OSP from wording', [cables[0].strands_text, cables[0].strands_per_core, cables[0].isp_osp, cables[0].basis], ['24 OS2', 24, 'osp', 'indoor/outdoor · loose tube · gel-filled']);
eq('note 2 = 24 OM4 + 12 OS2, ISP from wording', [cables[1].strands_text, cables[1].strands_per_core, cables[1].isp_osp, cables[1].basis], ['24 OM4 + 12 OS2', 36, 'isp', 'indoor · tight buffered']);
eq('notes 3/4 same cables', [cables[2].strands_text, cables[2].isp_osp, cables[3].strands_text, cables[3].isp_osp], ['24 OS2', 'osp', '24 OM4 + 12 OS2', 'isp']);
eq('no guess without words', readCableNotes([{ str: 'CODED NOTES:', cx_norm: 0.9, cy_norm: 0.1, left_norm: 0.85 }, { str: '1 FIBER CABLE.', cx_norm: 0.9, cy_norm: 0.12, left_norm: 0.85 }])[0]?.isp_osp ?? null, null);

// head end
const he = readHeadEnd(runs);
eq('head-end callouts per core', he, [{ qty: 60, note_number: 3, core: 'A' }, { qty: 1, note_number: 4, core: 'A' }, { qty: 60, note_number: 3, core: 'B' }, { qty: 1, note_number: 4, core: 'B' }]);
const chk = headEndCheck(he, blocks, cables);
eq('head end agrees with riser', chk.map((c) => [c.core, c.note_number, c.qty, c.riser_cores, c.ok]), [['A', 3, 60, 60, true], ['A', 4, 1, 1, true], ['B', 3, 60, 60, true], ['B', 4, 1, 1, true]]);
eq('head end mismatch flagged', headEndCheck([{ qty: 59, note_number: 3, core: 'A' }], blocks, cables)[0].ok, false);

// allowances
const groups = readAllowances(runs);
eq('two allowance notes, systems from titles', groups.map((g) => [g.system, g.unit_count]), [['ACCESS CONTROL DIAGRAM', 8], ['INTRUSION DETECTION DIAGRAM', 8]]);
const ac = groups[0].lines;
eq('access control lines', ac.map((l) => [l.per_unit_qty, l.unit, l.unit_count, l.per_text]), [[1, 'ea', 8, null], [15, 'ft', 8, 'per cabinet'], [80, 'ft', 8, 'per cabinet'], [1, 'ea', 8, 'per cabinet']]);
eq('copied wording kept as read', /INTRUSION DETECTION SYSTEM CABINET/.test(ac[1].item), true);
eq('keys unique across notes', new Set(groups.flatMap((g) => g.lines.map((l) => l.allowance_key))).size, 8);

// matching to the schedule
const sched = ['A502-1', 'B050C1', 'EB51A', 'FB28L-1', 'FB23B-1'];
eq('exact', matchRiserTr('A502-1', sched), { kind: 'exact', tr_name: 'A502-1' });
eq('punctuation only = exact', matchRiserTr('B050C-1', sched), { kind: 'exact', tr_name: 'B050C1' });
eq('instance suffix = close', matchRiserTr('EB51A-1', sched).kind, 'close');
eq('one letter differs = close', matchRiserTr('FB28-1', sched), { kind: 'close', tr_name: 'FB28L-1', why: 'one letter differs' });
eq('no match', matchRiserTr('105-30', sched), { kind: 'none', tr_name: null });
eq('no number', matchRiserTr(null, sched), { kind: 'none', tr_name: null });

// scope
const feeds = [
  { riser_key: 'a', tr_name: 'A502-1', match_kind: 'exact', core_a_note: 1, core_b_note: 1 },
  { riser_key: 'b', tr_name: null, suggested_tr: 'FB28L-1', match_kind: 'close', core_a_note: 1, core_b_note: 1 },
  { riser_key: 'c', tr_name: 'X-1', match_kind: 'added', core_a_note: 1, core_b_note: 1 },
  { riser_key: 'd', tr_name: null, core_a_note: 2, core_b_note: 2 },
];
eq('reconcile', reconcile(feeds, sched.map((n) => ({ tr_number: n }))), { riser: 4, in: 2, on_schedule: 1, added: 1, close: 1, out: 2,
  schedule_without_feed: ['B050C1', 'EB51A', 'FB28L-1', 'FB23B-1'], duplicates: [] });

// type and confirmation
const cab = cables.map((c) => ({ ...c }));
eq('type from cable', feedType(feeds[0], cab), { isp_osp: 'osp', why: null });
eq('type waits on confirmed cable', feedType(feeds[0], cab, { confirmedOnly: true }), { isp_osp: null, why: 'cable type not confirmed' });
eq('feed blocked until cable confirmed', feedBlocker(feeds[0], cab), 'cable type not confirmed');
cab[0].confirmed_at = '2026-09-27T16:00:00Z';
eq('feed confirmable', feedBlocker(feeds[0], cab), null);
eq('out feed blocked', feedBlocker(feeds[3], cab), 'add it in first — it is not on the schedule');
eq('close feed blocked', feedBlocker(feeds[1], cab), 'accept the schedule match or add it in first');
eq('mixed core types', feedType({ core_a_note: 1, core_b_note: 2 }, cab).why, 'core A and core B cables differ in type');
eq('conflict blocks', feedBlocker({ ...feeds[0], conflict: { removed_from_sheet: true } }, cab).startsWith('this TR is no longer'), true);
eq('cable needs a type', cableBlocker({ isp_osp: null }), 'set ISP or OSP first');
eq('allowance needs quantities', [allowanceBlocker({ per_unit_qty: null, unit_count: 8 }), allowanceBlocker({ per_unit_qty: 15, unit_count: null }), allowanceBlocker({ per_unit_qty: 15, unit_count: 8 })],
  ['set the quantity per unit first', 'set the unit count first', null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
