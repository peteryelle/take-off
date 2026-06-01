// detect.test.js — Step 3 gate. Pure fixtures encoding the proven offline numbers.
// Run: node test/detect.test.js
import { detectLabels, detectAll } from './public/lib/detect.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

// ─────────────────────────────────────────────────────────────────────────
// VA: anchor "N2" exact, families DV/DD/N. 93 faceplates each carry one N2.
// Distractors: the English-collision words ("INSTALL", "ADDITIONAL") and bare
// family tokens that must NOT be counted as anchors. Gate: 93.
// ─────────────────────────────────────────────────────────────────────────
console.log('VA fixture (anchor "N2" exact -> 93):');
{
  const items = [];
  for (let i = 0; i < 93; i++) {
    const x = (i % 30) / 30, y = Math.floor(i / 30) / 4;
    items.push(ti('N2', x, y));                 // the once-per-plate anchor
    items.push(ti('DV1', x + 0.005, y));        // nearby families (enrichment)
    items.push(ti(i % 3 ? 'DD2' : 'DD3', x, y + 0.006));
  }
  // collision distractors — must be ignored by an exact "N2" match
  items.push(ti('INSTALL', 0.5, 0.9), ti('ADDITIONAL', 0.6, 0.9), ti('N', 0.7, 0.9), ti('N12', 0.71, 0.9));
  const cfg = { type: 'outlet', anchor: 'N2', anchor_mode: 'exact', families: ['DV', 'DD', 'N'] };
  const inst = detectLabels(items, cfg);
  assert(inst.length === 93, `N2 anchor count == 93 (got ${inst.length})`);
  assert(inst.every((d) => d.uin === null), 'exact anchors carry no UIN (reconcile collapses by coord)');
  assert(inst.every((d) => d.families.includes('DV') || d.families.includes('DD')), 'families attached as enrichment');
  assert(!inst.some((d) => d.x === 0.7 && d.y === 0.9), 'bare "N" and "N12" not matched as N2');
}

// ─────────────────────────────────────────────────────────────────────────
// Army: anchor "SF\d+" regex (variant-code outlet), no nurse-call codes.
// Gate: 31 SF1. Distractors: "OFFICE", "STAFF" must not match.
// ─────────────────────────────────────────────────────────────────────────
console.log('Army fixture (anchor "SF\\\\d+" regex -> 31):');
{
  const items = [];
  for (let i = 0; i < 31; i++) items.push(ti('SF1', (i % 10) / 10, Math.floor(i / 10) / 4));
  items.push(ti('STAFF', 0.5, 0.9), ti('OFFICE', 0.6, 0.9), ti('SF', 0.7, 0.9)); // bare "SF" no digit
  const cfg = { type: 'outlet', anchor: 'SF\\d+', anchor_mode: 'regex', uin_pattern: '^SF\\d+$', families: ['W', 'G'] };
  const inst = detectLabels(items, cfg);
  assert(inst.length === 31, `SF\\d+ anchor count == 31 (got ${inst.length})`);
  assert(!inst.some((d) => d.x === 0.7 && d.y === 0.9), 'bare "SF" (no digit) not matched');
}

// ─────────────────────────────────────────────────────────────────────────
// QTS: prefix UIN tokens, multiple types each with its own config. Gate: the
// by-prefix split CAM 11 / VIC 10 / CR 7 / ACP 4 / DC 3 / KB 2 / ALM 2 / AD 1.
// Distractor: "ADDITIONAL" must not be caught by the AD type.
// ─────────────────────────────────────────────────────────────────────────
console.log('QTS fixture (prefix UIN tokens -> by-type):');
{
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const items = [];
  let i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) { items.push(ti(`${p}-EXT-${k}`, (i % 9) / 9, (i % 7) / 7)); i++; }
  }
  items.push(ti('ADDITIONAL', 0.95, 0.95), ti('AD', 0.9, 0.9)); // collisions for the AD type
  // one device type per prefix; uin_pattern requires the dash so bare "AD"/"ADDITIONAL" miss
  const deviceTypes = Object.keys(spec).map((p) => ({
    name: p,
    detection_config: { type: p, anchor: p, anchor_mode: 'regex', uin_pattern: `^${p}-[\\w-]+$` },
  }));
  const inst = detectAll(items, deviceTypes);
  const byType = countBy(inst, (d) => d.type);
  assert(JSON.stringify(byType) === JSON.stringify(spec), `by-prefix split matches ${JSON.stringify(spec)} (got ${JSON.stringify(byType)})`);
  assert(inst.length === 40, `total UIN labels == 40 (got ${inst.length})`);
  assert(inst.every((d) => d.uin && /-/.test(d.uin)), 'every prefix instance carries its full UIN');
  assert(!inst.some((d) => d.uin === 'AD' || d.uin === 'ADDITIONAL'), 'bare "AD"/"ADDITIONAL" rejected (dash required)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
