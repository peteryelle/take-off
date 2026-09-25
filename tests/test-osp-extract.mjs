// Gate: the JS port of extract_conduit.py reproduces the Python's validated
// T-108 output. Input: fixtures/t108-osp-input.json (T-108's black/red/blue
// linework + text from pdf.js). Expected: fixtures/t108-osp-expected/*.csv —
// the Python's own output files, unchanged.
// One documented difference: toEND-16's note (see buildGraph in osp-extract.js).
import { readFileSync } from 'node:fs';
import { runOsp, limitsFromRules } from '../public/lib/osp-extract.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const fx = (p) => new URL('../fixtures/' + p, import.meta.url);

function csv(path) {
  const text = readFileSync(fx(path), 'utf8').replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const same = (a, b) => { a = String(a); b = b == null ? '' : String(b); if (a === b) return true; const x = Number(a), y = Number(b); return a !== '' && b !== '' && !Number.isNaN(x) && !Number.isNaN(y) && Math.abs(x - y) < 1e-9; };
const mismatches = (exp, got, key, skip = () => false) => {
  const by = new Map(got.map((r) => [r[key], r])); const out = [];
  for (const e of exp) { const g = by.get(e[key]); if (!g) { out.push(`${e[key]} missing`); continue; } for (const c of Object.keys(e)) if (!skip(e, c) && !same(e[c], c === 'demarc' && typeof g[c] === 'boolean' ? (g[c] ? 'True' : 'False') : g[c])) out.push(`${e[key]}.${c}: ${e[c]} vs ${g[c]}`); }
  return out;
};

const input = JSON.parse(readFileSync(fx('t108-osp-input.json')));
const r = runOsp({ draws: input.draws, tcItems: input.tcItems, view: input.view, filename: input.file });

ok(r.problems.length === 0, 'no recognition problems on T-108');
ok(r.scale === 20 && Math.abs(r.scale_measured - 19.98) < 0.01, 'scale 1" = 20\' (19.98 measured)');
ok(r.fragments === 621 && r.chains === 19 && Math.abs(r.tol - 11.25) < 1e-9, '621 fragments, 19 chains, 11.25 pt bridge tolerance');

let m = mismatches(csv('t108-osp-expected/segments.csv'), r.segments, 'segment');
ok(r.segments.length === 29 && !m.length, `29 segments identical in every column${m.length ? ' — ' + m.slice(0, 3).join('; ') : ''}`);
m = mismatches(csv('t108-osp-expected/nodes.csv'), r.nodes, 'id', (e, c) => c === 'x' || c === 'y' || (e.id === 'toEND-16' && c === 'note'));
ok(r.nodes.length === 29 && !m.length, `29 nodes identical (type, degree, balance, notes)${m.length ? ' — ' + m.slice(0, 3).join('; ') : ''}`);
ok(r.nodes.find((n) => n.id === 'toEND-16').note === "near 'REFER TO T1.B'", "toEND-16 reads the wrapped 'REFER TO SHEET T1.B' callout (documented improvement)");
m = mismatches(csv('t108-osp-expected/callouts.csv'), r.callouts, 'id');
ok(r.callouts.length === 35 && !m.length, `35 callouts identical${m.length ? ' — ' + m.slice(0, 3).join('; ') : ''}`);
ok(r.callouts.filter((c) => c.method === 'leader').length === 32, '32 matched by leader, 3 by proximity');
m = mismatches(csv('t108-osp-expected/discrepancies.csv'), r.discrepancies, 'item');
ok(r.discrepancies.length === 20 && !m.length, `20 discrepancies identical${m.length ? ' — ' + m.slice(0, 3).join('; ') : ''}`);
const tk = csv('t108-osp-expected/takeoff.csv');
ok(tk.length === r.takeoff.length && tk.every((t, i) => same(t.quantity, r.takeoff[i].quantity) && t.item === r.takeoff[i].item), 'take-off totals identical (24 rows)');
const val = (item) => r.takeoff.find((t) => t.item === item).quantity;
ok(val('New route (red)') === 1043 && val('Core-A cable') === 26529 && val('Core-B cable') === 22484, "headline totals: 1,043 ft new route, 26,529 ft Core-A, 22,484 ft Core-B");

// Limits come from WF1 rules; defaults only when a rule is missing.
ok(JSON.stringify(limitsFromRules([])) === JSON.stringify({ osp_pull_ft: 250, interior_pull_ft: 100, bends_deg: 180 }), 'default limits when WF1 has no rules');
const strict = runOsp({ draws: input.draws, tcItems: input.tcItems, view: input.view, filename: input.file, rules: [{ rule_kind: 'pull_limit_ft', rule_value: 200, used_by_step: 'WF3' }] });
ok(strict.segments.filter((s) => s.flags.includes('PULL LIMIT')).length > r.segments.filter((s) => s.flags.includes('PULL LIMIT')).length, 'a stricter WF1 pull limit (200 ft) flags more runs');

// Fails loudly on a sheet it cannot read.
const blank = runOsp({ draws: [], tcItems: input.tcItems, view: input.view, filename: input.file });
ok(blank.problems[0].startsWith('No red or blue conduit linework'), 'no conduit linework -> clear problem message');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
