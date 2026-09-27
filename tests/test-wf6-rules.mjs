// tests/test-wf6-rules.mjs — WF6 rack rules read from the rack elevation sheet
// Run: node tests/test-wf6-rules.mjs
// Fixture: real pdf.js 3.11.174 getTextContent() of the EHRM rack elevation sheet.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCodedNotes } from '../public/lib/parse-coded-notes.js';
import { linesFromTextContent, readDrawingNotes, readElevations, readNoteFields, suggestRules, missingParams,
  sizeTr, splitEven, capacityFor, summaryOf, METHOD_KEYS, confirmBlocker, countsSomething, isConfirmed } from '../public/lib/wf6-rules.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/wf6-rack-sheet-textcontent.json'), 'utf8'))['T-501'];
const runs = linesFromTextContent(fx.items, fx.width, fx.height);

// coded notes: the wrapped "12 STRANDS ..." line is not a phantom note 12
const coded = parseCodedNotes(runs);
eq('ten coded notes in order', coded.map((n) => n.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
eq('note 3 keeps its wrapped strand line', /12 STRANDS OF OS1 PER CORE\. IF OUT SIDE PLANT CABLING, 24-STRANDS OF OS2 PER CORE\.$/.test(coded[2].text), true);
eq('note 10 read', /26RU WALL-MOUNT CABINET/.test(coded[9].text), true);

// drawing notes: no drawing labels merged in from the far side of the sheet
const dn = readDrawingNotes(runs);
eq('seven drawing notes', dn.map((d) => d.number), [1, 2, 3, 4, 5, 6, 7]);
eq('DN 5 has no stray label', /48-PORT/.test(dn[4].text), false);
eq('DN 2 is the split rule', /DIVIDED AS EVENLY/.test(dn[1].text), true);

// elevations from titles, bubbles and capacity labels
const el = readElevations(runs);
const racksOnly = el.filter((e) => e.rack_count !== 'wall_mount').sort((a, b) => a.rack_count - b.rack_count);
eq('rack elevations', racksOnly.map((e) => [e.rack_count, e.detail_ref, e.capacity_passive, e.capacity_active]),
  [['1', '1', 288, 144], ['2', '5', 480, 240], ['3', '2', 960, 480], ['4', '6', 1248, 480]]);
eq('4-rack active is "over"', racksOnly[3].active_over, true);
eq('wall-mount details (a callout with ";" is not a title)', el.filter((e) => e.rack_count === 'wall_mount').map((e) => e.detail_ref).sort(), ['3', '4']);
eq('capacity lookup', capacityFor(el, 3), { passive: 960, active: 480, detail_ref: '2' });

// fields read from wording
const f3 = readNoteFields(coded[2].text);
eq('note 3 fields', [f3.ru, f3.slots, f3.cores, f3.strands.isp.total, f3.strands.osp.total, f3.parts.length], [1, 12, 2, 36, 24, 2]);
eq('note 3 strand parts', f3.strands.isp.parts, [{ n: 24, type: 'OM4' }, { n: 12, type: 'OS1' }]);
eq('note 4 ports', readNoteFields(coded[3].text).ports, 48);
eq('note 1 part (wrapped hyphen joined)', readNoteFields(coded[0].text).part, 'ORTRONICS MIGHTY-MO: OR-MM2073038-W');
eq('note 7 owner furnished', readNoteFields(coded[6].text).owner_furnished, true);
eq('note 8 refer only', readNoteFields(coded[7].text).refer_only, true);
eq('generic: no strands -> null', readNoteFields('1RU BLANK COVER PLATE, BLACK.').strands, null);

// suggested rules
const rules = suggestRules(coded, dn);
const R = (k) => rules.find((r) => r.rule_key === k);
eq('methods suggested from wording', ['CN1', 'CN2', 'CN3', 'CN3-cassette', 'CN4', 'CN5', 'CN6', 'CN7', 'CN8', 'CN9', 'CN10'].map((k) => R(k).qty_rule),
  ['per_rack', 'racks_plus_one', 'per_tr', 'strands_div_cassette', 'schedule_div_racks', 'unused_ru', 'per_panel', 'terminations_div_ports', 'none', 'per_panel', 'per_wall_mount']);
eq('all methods known', rules.every((r) => METHOD_KEYS.includes(r.qty_rule)), true);
eq('rack RU is capacity', [R('CN1').ru, R('CN1').params.ru_role.v], [45, 'capacity']);
eq('cassette strands from the sheet', [R('CN3-cassette').params.strands_isp, R('CN3-cassette').params.strands_osp, R('CN3-cassette').params.cores],
  [{ v: 36, source: 'sheet' }, { v: 24, source: 'sheet' }, { v: 2, source: 'sheet' }]);
eq('fibers per cassette is NOT taken from "(12) CASSETTES"', R('CN3-cassette').params.fibers_per_cassette, { v: null, source: 'user' });
eq('slots per unit read', R('CN3-cassette').params.slots_per_unit.v, 12);
eq('cassette has no RU of its own', R('CN3-cassette').ru, null);
eq('split rule from DN 2', [R('CN4').params.split_even.v, R('CN7').params.split_even.v], [true, true]);
eq('ports per switch not stated -> user', R('CN7').params.ports_per_switch, { v: null, source: 'user' });
eq('zones from DN 3', [R('CN3').zone, R('CN4').zone, R('CN7').zone, R('CN2').zone], ['top', 'middle', 'top', 'side']);
eq('missing values', rules.filter((r) => r.note_kind === 'coded').map((r) => [r.rule_key, missingParams(r)]).filter(([, m]) => m.length),
  [['CN3-cassette', ['fibers_per_cassette']], ['CN5', ['switch_ru', 'power_ru_per_rack']], ['CN6', ['each']], ['CN7', ['ports_per_switch']], ['CN9', ['each']]]);
eq('DN 7 flagged: no quantity', [R('DN7').qty_rule, R('DN7').params.no_quantity.v], ['not_stated', true]);
eq('DN 3 layout', R('DN3').qty_rule, 'layout');
eq('no sheet numbers in any rule key', rules.every((r) => !/T-\d/.test(r.rule_key)), true);

// sizing
eq('split 14 over 3', splitEven(14, 3), [5, 5, 4]);
eq('split with no racks', splitEven(5, 0), []);
const tr = { tr_name: 'X1', racks: 3, panels: 14, terminations: 620, isp_osp: 'isp', wall_mount: false };
let s = sizeTr(rules, tr, el);
eq('nothing counted while values are missing', s.items.find((i) => i.rule_key === 'CN7').note, 'set Ports per switch');
const set = (k, p, v) => { R(k).params[p] = { v, source: 'user' }; };
set('CN3-cassette', 'fibers_per_cassette', 12); set('CN7', 'ports_per_switch', 48); set('CN6', 'each', 1); set('CN9', 'each', 0.5);
set('CN5', 'switch_ru', 1); set('CN5', 'power_ru_per_rack', 6);
s = sizeTr(rules, tr, el);
const Q = (k) => s.items.find((i) => i.rule_key === k);
eq('racks', Q('CN1').qty, 3);
eq('sidecars racks+1', Q('CN2').qty, 4);
eq('fiber unit per TR', Q('CN3').qty, 1);
eq('cassettes ISP ceil(36/12)x2', Q('CN3-cassette').qty, 6);
eq('panels from schedule, split', [Q('CN4').qty, Q('CN4').per_rack], [14, [5, 5, 4]]);
eq('switches ceil(620/48), split', [Q('CN7').qty, Q('CN7').per_rack], [13, [5, 4, 4]]);
eq('1RU mgr per panel', Q('CN6').qty, 14);
eq('2RU mgr ratio 0.5', Q('CN9').qty, 7);
eq('blanks = 3x45 - (1+14+14+14+13+18)', Q('CN5').qty, 61);
eq('wall-mount off', Q('CN10').qty, 0);
eq('within capacity', s.check.level, 'ok');

const osp = sizeTr(rules, { ...tr, isp_osp: 'osp' }, el);
eq('cassettes OSP ceil(24/12)x2', osp.items.find((i) => i.rule_key === 'CN3-cassette').qty, 4);
const pend = sizeTr(rules, { ...tr, isp_osp: null }, el);
eq('cassettes wait on WF7', pend.items.find((i) => i.rule_key === 'CN3-cassette').note, 'ISP/OSP waits on WF7');
const over = sizeTr(rules, { tr_name: 'X2', racks: 1, panels: 7, terminations: 336, isp_osp: 'isp' }, el);
eq('capacity check flags', [over.check.level, over.check.text], ['warn', '336 outlets > 288 on 1 rack']);
const none = sizeTr(rules, { tr_name: 'X3', racks: 0, panels: 2, terminations: 60 }, el);
eq('no new racks: rack items zero', ['CN1', 'CN2', 'CN3', 'CN3-cassette', 'CN5'].map((k) => none.items.find((i) => i.rule_key === k).qty), [0, 0, 0, 0, 0]);
eq('no new racks check', none.check.level, 'none');
const noWf5 = sizeTr(rules, { tr_name: 'X4', racks: null, panels: 2, terminations: 60 }, el);
eq('no WF5 count', [noWf5.items.find((i) => i.rule_key === 'CN1').note, noWf5.check.level], ['rack count not entered in WF5', 'open']);
eq('no 5-rack elevation', sizeTr(rules, { ...tr, racks: 5 }, el).check.text, 'no typical 5-rack elevation on the sheet');

// wall-mount flag from WF5
const wm = sizeTr(rules, { tr_name: 'G1', racks: 0, panels: 1, terminations: 20, isp_osp: null, wall_mount: true }, el);
eq('wall-mount TR counts the cabinet', [wm.items.find((i) => i.rule_key === 'CN10').qty, wm.check.text], [1, 'wall-mount TR']);
eq('wall-mount unknown when WF5 is empty', sizeTr(rules, { tr_name: 'G2', racks: null, panels: 1, terminations: 20 }, el).items.find((i) => i.rule_key === 'CN10').note,
  'nothing entered for this TR in WF5 (wall-mount checkbox)');

// a value changed by the user changes the result (nothing is hard-coded)
set('CN3-cassette', 'fibers_per_cassette', 24);
eq('24 fibers per cassette -> ceil(36/24)x2', sizeTr(rules, tr, el).items.find((i) => i.rule_key === 'CN3-cassette').qty, 4);

eq('summary', summaryOf(rules, [s, over, none]), { rules_counting: 10, confirmed: 0, coded: 10, user_set: 6, user_missing: 0, trs: 3, over_capacity: 1, waits_wf7: 0 });

// confirmation: only confirmed rules are applied when the page asks for it
eq('counting rules (drawing notes and "not counted" excluded)', rules.filter(countsSomething).map((r) => r.rule_key),
  ['CN1', 'CN2', 'CN3', 'CN3-cassette', 'CN4', 'CN5', 'CN6', 'CN7', 'CN9', 'CN10']);
eq('unconfirmed rule not applied', sizeTr(rules, tr, el, { requireConfirmed: true }).items.find((i) => i.rule_key === 'CN1').note, 'rule not confirmed');
R('CN1').confirmed_at = '2026-09-27T15:00:00Z';
eq('confirmed rule applied', sizeTr(rules, tr, el, { requireConfirmed: true }).items.find((i) => i.rule_key === 'CN1').qty, 3);
eq('blanks wait for confirmation too', sizeTr(rules, tr, el, { requireConfirmed: true }).items.find((i) => i.rule_key === 'CN5').note, 'rule not confirmed');
eq('can confirm when complete', confirmBlocker(R('CN4')), null);
const blankCopy = { ...R('CN5'), params: { ...R('CN5').params, switch_ru: { v: null, source: 'user' } } };
eq('cannot confirm with a missing value', confirmBlocker(blankCopy), 'set RU per switch first');
eq('cannot confirm with a changed sheet', confirmBlocker({ ...R('CN4'), conflict: { item: 'x' } }).startsWith('the sheet now reads'), true);
eq('cannot confirm "quantity not stated"', confirmBlocker({ ...R('CN4'), qty_rule: 'not_stated' }), 'pick how it is counted first');
eq('summary counts confirmed', summaryOf(rules, []).confirmed, 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
