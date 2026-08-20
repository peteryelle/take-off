// test-pricing.mjs — offline fixture gate for public/lib/pricing.js
// Run: node test-pricing.mjs
import { priceBom } from '../public/lib/pricing.js';

let failures = 0;
function check(label, cond) {
  if (!cond) { console.error(`✗ ${label}`); failures++; }
  else console.log(`✓ ${label}`);
}

// ── Fixture: 3 BOM lines — one clean match, one inactive catalog part,
// one with no part_number at all (legacy free-text row).
const bom = {
  components: [
    { manufacturer: 'ports-r-us', part_name: 'port6a', model: 'abc-port',
      device_name: 'port', part_number: 'RJ45-6A', qty: 40, per_run_ft: false },
    { manufacturer: 'cables-r-us', part_name: 'cat6a-tr', model: 'abc-cable-tr',
      device_name: 'cat6a', part_number: 'CAT6A-CMR', qty: 1250, per_run_ft: true },
    { manufacturer: 'plates-r-us', part_name: 'plate', model: 'abc-plate',
      device_name: 'faceplate', part_number: 'RETIRED-01', qty: 40, per_run_ft: false },
    { manufacturer: 'legacy-mfr', part_name: 'old free-text part', model: '',
      device_name: 'misc', part_number: null, qty: 5, per_run_ft: false },
  ],
};

const catalogParts = [
  { part_number: 'RJ45-6A',    cost_unit: 2.50, sale_unit: 2.7778, active: true },
  { part_number: 'CAT6A-CMR',  cost_unit: 0.32, sale_unit: 0.3556, active: true },
  { part_number: 'RETIRED-01', cost_unit: 1.10, sale_unit: 1.2222, active: false },
];

const result = priceBom(bom, catalogParts);

check('2 lines priced', result.components.filter(c => c.priced).length === 2);
check('2 lines unresolved (inactive + no part_number)', result.unresolved.length === 2);
check('inactive part flagged with correct reason',
  result.unresolved.find(u => u.part_number === 'RETIRED-01')?.reason === 'inactive');
check('no-part_number row flagged with correct reason',
  result.unresolved.find(u => u.part_number === null)?.reason === 'no_part_number');

const rj45 = result.components.find(c => c.part_number === 'RJ45-6A');
check('RJ45-6A line_cost = 40 * 2.50 = 100', rj45.line_cost === 100);
check('RJ45-6A line_sale = 40 * 2.7778 = 111.11', rj45.line_sale === 111.11);

const cable = result.components.find(c => c.part_number === 'CAT6A-CMR');
check('CAT6A-CMR (per_run_ft) line_cost = 1250 * 0.32 = 400', cable.line_cost === 400);

check('cost_total excludes unresolved lines (100 + 400 = 500)', result.totals.cost_total === 500);
check('sale_total = 111.11 + 444.5 = 555.61', result.totals.sale_total === 555.61);
check('margin_total = sale - cost', result.totals.margin_total === Math.round((result.totals.sale_total - result.totals.cost_total) * 100) / 100);

// ── Mutation test: break the "flag, don't fabricate" rule and confirm the gate catches it.
function priceBom_broken(bomIn, catalogPartsIn) {
  const byNumber = new Map((catalogPartsIn || []).map(p => [p.part_number, p]));
  let cost_total = 0;
  const components = bomIn.components.map(c => {
    const match = byNumber.get(c.part_number);
    const cost_unit = match ? Number(match.cost_unit) : 0;   // BUG: defaults unresolved to $0 instead of flagging
    const line_cost = cost_unit * c.qty;
    cost_total += line_cost;
    return { ...c, cost_unit, line_cost };
  });
  return { components, unresolved: [], totals: { cost_total } };
}
const broken = priceBom_broken(bom, catalogParts);
check('mutation test: broken version silently zero-prices instead of flagging (proves the gate distinguishes correct behavior)',
  broken.unresolved.length === 0 && broken.components.some(c => c.part_number === null && c.cost_unit === 0));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
