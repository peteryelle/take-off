// discover-config.test.js — Step 6 gate. Discovery-written catalog must reproduce
// the same counts as the hand-authored Step-1 rows, across all three jobs.
// Run: node test/discover-config.test.js
import { buildCatalog } from './public/lib/discover-config.js';
import { detectLabels } from './public/lib/detect.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
// tokens -> text_items with spread-out dummy positions (positions don't affect anchor counts)
const itemsOf = (tokens) => tokens.map((t, i) => ({ str: t, cx_norm: (i % 50) / 50, cy_norm: Math.floor(i / 50) / 50 }));
// run a produced config through the real detector
const detectCount = (cfgRow, items) => detectLabels(items, { ...cfgRow.detection_config, type: cfgRow.name }).length;

// ── VA: no legend for the outlet codes -> anchor confirmed by frequency ──────
console.log('VA: discovery reproduces 93 N2 / WAP / 180 (frequency-confirmed):');
{
  const candidates = [
    { name: 'OUTLET: DUPLEX', kind: 'exact', anchor: 'N2', families: ['DV', 'DD', 'N'], legend_present: false, has_symbol: false },
    { name: 'WAP',            kind: 'exact', anchor: 'WAP', families: [],                legend_present: true,  has_symbol: true },
    { name: 'camera 180',     kind: 'exact', anchor: '180', families: [],                legend_present: true,  has_symbol: true },
  ];
  const tokens = [
    ...Array(93).fill('N2'), ...Array(11).fill('WAP'), ...Array(7).fill('180'),
    'INSTALL', 'ADDITIONAL', 'N', 'N12',     // collision distractors
  ];
  const items = itemsOf(tokens);
  const { types, schedule } = buildCatalog(candidates, tokens, null);

  const out = types.find((t) => t.name === 'OUTLET: DUPLEX');
  assert(out.detection_config.anchor === 'N2' && out.detection_config.anchor_mode === 'exact', 'outlet anchor N2 / exact');
  assert(JSON.stringify(out.detection_config.families) === JSON.stringify(['DV', 'DD', 'N']), 'outlet families DV/DD/N carried');
  assert(JSON.stringify(out.detection_config.sources) === JSON.stringify(['label']), 'VA outlet sources = [label] (no schedule)');
  assert(out.detection_config.source === 'frequency' && out.detection_config.anchor_confidence === 'medium',
    'frequency-derived: source frequency, confidence medium');
  assert(detectCount(out, items) === 93, `outlet config detects 93 (got ${detectCount(out, items)})`);
  assert(detectCount(types.find((t) => t.name === 'WAP'), items) === 11, 'WAP config detects 11');
  assert(detectCount(types.find((t) => t.name === 'camera 180'), items) === 7, 'camera config detects 7');
  const wap = types.find((t) => t.name === 'WAP');
  assert(wap.detection_config.source === 'legend' && wap.detection_config.anchor_confidence === 'high', 'WAP legend-matched: source legend, confidence high');
  assert(schedule === null, 'no schedule block for VA');
}

// ── Equivalence to the hand-authored Step-1 N2 row (the literal gate) ────────
console.log('VA: discovery config == hand-authored Step-1 row (count-equivalent):');
{
  const hand = { name: 'OUTLET: DUPLEX', detection_config: { anchor: 'N2', anchor_mode: 'exact', families: ['DV', 'DD', 'N'], sources: ['label'] } };
  const tokens = [...Array(93).fill('N2'), 'INSTALL', 'ADDITIONAL'];
  const items = itemsOf(tokens);
  const disc = buildCatalog([{ name: 'OUTLET: DUPLEX', kind: 'exact', anchor: 'N2', families: ['DV', 'DD', 'N'], legend_present: false }], tokens, null)
    .types.find((t) => t.name === 'OUTLET: DUPLEX');
  assert(detectCount(hand, items) === detectCount(disc, items) && detectCount(disc, items) === 93,
    `hand vs discovery both detect 93 (hand ${detectCount(hand, items)}, disc ${detectCount(disc, items)})`);
  assert(disc.detection_config.anchor === hand.detection_config.anchor &&
         disc.detection_config.anchor_mode === hand.detection_config.anchor_mode,
    'anchor + mode match the hand row');
}

// ── Army: variant-code outlet, anchor by prefix -> SF\d+ ─────────────────────
console.log('Army: discovery reproduces 31 SF1 (prefix, digit-suffix pattern):');
{
  const candidates = [{ name: 'OUTLET', kind: 'prefix', anchor: 'SF', families: ['W', 'G'], legend_present: true, has_symbol: false }];
  const tokens = [...Array(31).fill('SF1'), 'STAFF', 'OFFICE', 'SF'];   // STAFF/OFFICE/bare SF must miss
  const items = itemsOf(tokens);
  const { types } = buildCatalog(candidates, tokens, null);
  const sf = types[0];
  assert(sf.detection_config.uin_pattern === '^SF\\d+$', `derived digit-suffix pattern ^SF\\d+$ (got ${sf.detection_config.uin_pattern})`);
  assert(detectCount(sf, items) === 31, `SF config detects 31 (got ${detectCount(sf, items)})`);
  assert(JSON.stringify(sf.detection_config.sources) === JSON.stringify(['label']), 'Army sources = [label] (no schedule)');
}

// ── QTS: rich legend + schedule -> prefix anchors, schedule columns mapped ───
console.log('QTS: discovery reproduces by-prefix 40 + maps schedule + kills AD collision:');
{
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const candidates = Object.keys(spec).map((p) => ({ name: p, kind: 'prefix', anchor: p, families: [], legend_present: true, has_symbol: true }));
  const tokens = [];
  for (const [p, n] of Object.entries(spec)) for (let k = 1; k <= n; k++) tokens.push(`${p}-EXT-${k}`);
  tokens.push('ADDITIONAL', 'INSTALL', 'CR', 'VIC');           // collisions + bare tokens
  const items = itemsOf(tokens);
  const scheduleInput = { present: true, headerTokens: ['UIN', 'DETAIL SHEET', 'CABLE DEST 1', 'CABLE DEST 2'], locatorTitle: 'DETAIL SCHEDULE' };
  const { types, schedule } = buildCatalog(candidates, tokens, scheduleInput);

  const byType = countBy(types.flatMap((t) => detectLabels(items, { ...t.detection_config, type: t.name })), (d) => d.type);
  assert(JSON.stringify(byType) === JSON.stringify(spec), `by-prefix detect matches ${JSON.stringify(spec)} (got ${JSON.stringify(byType)})`);
  const ad = types.find((t) => t.name === 'AD');
  assert(detectCount(ad, items) === 1, `AD detects 1 (AD-EXT-1), not "ADDITIONAL" (got ${detectCount(ad, items)})`);
  assert(types.every((t) => JSON.stringify(t.detection_config.sources) === JSON.stringify(['schedule', 'label', 'symbol'])),
    'QTS prefix types sourced schedule+label+symbol');
  assert(schedule && schedule.columns.uin === 'UIN' && schedule.columns.detail_sheet === 'DETAIL SHEET' &&
    JSON.stringify(schedule.columns.cable_dest) === JSON.stringify(['CABLE DEST 1', 'CABLE DEST 2']) && schedule.type_from === 'uin_prefix',
    'schedule columns mapped (uin / detail_sheet / cable_dest[]) + type_from');
}

// ── Full discovery: nominate anchors from RAW candidates (no anchor decided) ──
console.log('discoverCatalog: nominate anchors from raw legend/vision candidates:');
{
  // VA: no legend for outlet codes -> N2 nominated by frequency (~once per plate)
  const vaRaw = [
    { name: 'OUTLET: DUPLEX', nearby_text: ['DV', 'DD', 'N'], approximate_count: 93, legend_name: null, has_symbol: true },
    { name: 'WAP',            nearby_text: ['WAP'],            approximate_count: 11, legend_name: 'WAP', has_symbol: true },
    { name: 'camera 180',     nearby_text: ['180'],            approximate_count: 7,  legend_name: 'Camera', has_symbol: true },
  ];
  const vaTokens = [
    ...Array(93).fill('N2'),
    ...Array(40).fill('DV1'), ...Array(50).fill('DD2'), ...Array(20).fill('DD3'), // families vary, never ~93
    ...Array(11).fill('WAP'), ...Array(7).fill('180'),
    'INSTALL', 'ADDITIONAL',
  ];
  const { discoverCatalog } = await import('./public/lib/discover-config.js');
  const va = discoverCatalog(vaRaw, vaTokens, null);
  const vaOut = va.types.find((t) => t.name === 'OUTLET: DUPLEX');
  assert(vaOut.detection_config.anchor === 'N2' && vaOut.detection_config.anchor_mode === 'exact',
    `nominated N2 as the once-per-plate anchor (got ${vaOut.detection_config.anchor})`);
  assert(JSON.stringify(vaOut.detection_config.families) === JSON.stringify(['DV', 'DD', 'N']), 'families = DV/DD/N');
  assert(detectCount(vaOut, itemsOf(vaTokens)) === 93, `nominated config detects 93 (got ${detectCount(vaOut, itemsOf(vaTokens))})`);

  // Army: legend prefix SF -> prefix anchor, digit pattern
  const army = discoverCatalog(
    [{ name: 'OUTLET', nearby_text: ['SF'], legend_prefix: 'SF', approximate_count: 31, legend_name: 'SF' }],
    [...Array(31).fill('SF1'), 'STAFF', 'OFFICE'], null);
  assert(detectCount(army.types[0], itemsOf([...Array(31).fill('SF1'), 'STAFF', 'OFFICE'])) === 31, 'Army nominated SF prefix detects 31');

  // QTS: legend prefixes -> prefix anchors + schedule
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const qtsRaw = Object.keys(spec).map((p) => ({ name: p, nearby_text: [p], legend_prefix: p, approximate_count: spec[p], legend_name: p, has_symbol: true }));
  const qtsTokens = [];
  for (const [p, n] of Object.entries(spec)) for (let k = 1; k <= n; k++) qtsTokens.push(`${p}-EXT-${k}`);
  qtsTokens.push('ADDITIONAL', 'INSTALL');
  const qts = discoverCatalog(qtsRaw, qtsTokens, { present: true, headerTokens: ['UIN', 'DETAIL SHEET', 'CABLE DEST 1', 'CABLE DEST 2'], locatorTitle: 'DETAIL SCHEDULE' });
  const qByType = countBy(qts.types.flatMap((t) => detectLabels(itemsOf(qtsTokens), { ...t.detection_config, type: t.name })), (d) => d.type);
  assert(JSON.stringify(qByType) === JSON.stringify(spec), `QTS discoverCatalog by-prefix == ${JSON.stringify(spec)} (got ${JSON.stringify(qByType)})`);
  assert(qts.schedule && qts.schedule.columns.uin === 'UIN', 'QTS schedule block emitted by discoverCatalog');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
