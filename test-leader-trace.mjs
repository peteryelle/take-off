// test-leader-trace.mjs
// Gate: the VA Syracuse pg5 N2 leadered cluster must resolve to its 9 device
// locations from raw vector segments — origin found near (not on) the anchor,
// 9 endpoints matching the drawn arrowheads. Run: node test-leader-trace.mjs
import { readFileSync } from 'node:fs';
import { traceLeaderFan } from './public/lib/leader-trace.js';

const fx = JSON.parse(readFileSync('./fixtures/va-leader-fan-pg5.json', 'utf8'));
const [W, H] = fx.page;
const anchor = fx.anchor_pt;

const res = traceLeaderFan(fx.segments_pt, anchor);

let pass = true;
const fail = (m) => { pass = false; console.error('  ✗ ' + m); };

if (!res.ok) fail(`trace failed: ${res.reason}`);

// 1) count matches the drawn fan
if (res.endpoints.length !== fx.expected_endpoints_norm.length)
  fail(`fanout ${res.endpoints.length}, expected ${fx.expected_endpoints_norm.length}`);

// 2) origin is near the anchor but NOT the anchor (the bug we're fixing)
if (res.ok) {
  const off = Math.hypot(res.origin[0] - anchor[0], res.origin[1] - anchor[1]);
  if (off < 5) fail('origin sits on the anchor — leader not traced');
  if (off > 200) fail(`origin ${off.toFixed(0)}pt from anchor — too far`);
}

// 3) every drawn endpoint is recovered (norm space, tol ~0.01)
const got = res.endpoints.map(([x, y]) => [x / W, y / H]);
const TOL = 0.012;
for (const exp of fx.expected_endpoints_norm) {
  const hit = got.find((g) => Math.hypot(g[0] - exp[0], g[1] - exp[1]) < TOL);
  if (!hit) fail(`missing endpoint near (${exp[0]}, ${exp[1]})`);
}

// 4) none of the recovered locations is the old anchor coordinate
const anchorNorm = [anchor[0] / W, anchor[1] / H];
if (got.some((g) => Math.hypot(g[0] - anchorNorm[0], g[1] - anchorNorm[1]) < 0.005))
  fail('an endpoint still sits on the anchor');

console.log(`leader-trace — ${fx.source}`);
console.log(`  origin norm (${(res.origin?.[0] / W).toFixed(3)}, ${(res.origin?.[1] / H).toFixed(3)}), fanout ${res.endpoints?.length}`);
console.log(pass ? '  ✓ PASS (9/9 device locations recovered from raw vectors)' : '  FAILED');
process.exit(pass ? 0 : 1);
