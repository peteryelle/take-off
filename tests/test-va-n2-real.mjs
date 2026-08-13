// test-va-n2-real.mjs — Step 3 gate against REAL extracted page data.
// AE-2 page 5 = ATTACHMENT_9 p5 "VA Syracuse". Primary anchor N# (here uniformly
// N2), family DV#-DD#-N# collapsed onto the anchor. Hand-counted locked = 93.
// The synthetic VA case in test-detect.mjs proves the rule; THIS proves the rule
// holds on the real 1584-item extraction — detect AND reconcile both stay 93.
// Run: node test-va-n2-real.mjs
import { detectLabels } from '../public/lib/detect.js';
import { reconcile } from '../public/lib/reconcile.js';
import fs from 'fs';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const norm = (s) => String(s || '').trim().toUpperCase();

const raw = JSON.parse(fs.readFileSync('fixtures/va-labelstamp-textitems.json', 'utf8'));
const items = Array.isArray(raw) ? raw : (raw.textItems || raw.items || raw.text_items || []);
const LOCKED = 93;

console.log('AE-2 p5 (VA Syracuse) — N2 primary anchor, real extraction:');

// Page assumption: N2 is the ONLY N# token (so exact "N2" and regex "N\d+" agree).
// If a re-extraction ever introduces N1/N3 etc., this guard flags it before counts drift.
const nCodes = {};
for (const t of items) { const s = norm(t.str); if (/^N\d+$/.test(s)) nCodes[s] = (nCodes[s] || 0) + 1; }
assert(Object.keys(nCodes).length === 1 && nCodes.N2 === LOCKED,
  `only N# token is N2 x${LOCKED} (got ${JSON.stringify(nCodes)})`);

// detect.js — exact "N2" primary anchor, DV/DD/N families as enrichment.
const cfg = { type: 'outlet', anchor: 'N2', anchor_mode: 'exact', families: ['DV', 'DD', 'N'] };
const inst = detectLabels(items, cfg);
assert(inst.length === LOCKED, `detect N2 anchor count == ${LOCKED} (got ${inst.length})`);
assert(inst.every((d) => d.uin === null), 'exact anchors carry no UIN (reconcile collapses by coord)');
assert(inst.every((d) => d.families && d.families.length), 'every faceplate carries DV/DD family enrichment');

// reconcile — the no-UIN coordinate-collapse path (the one that over-merged cameras).
// At the shipped default (coordKeyDecimals=4) all 93 must survive; closest two
// faceplates are ~0.008 apart, 80x the 0.0001 quant granularity.
const catalog = { outlet: { sources: ['label'] } };
const recsDefault = reconcile(catalog, inst, [], []);
assert(recsDefault.length === LOCKED, `reconcile @ default keeps ${LOCKED} (got ${recsDefault.length})`);
const recs3 = reconcile(catalog, inst, [], [], { coordKeyDecimals: 3 });
assert(recs3.length === LOCKED, `reconcile @ decimals=3 keeps ${LOCKED} (got ${recs3.length})`);

console.log(failures ? `\n${failures} FAILED` : '\nall PASS');
process.exit(failures ? 1 : 0);
