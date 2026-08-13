// Gate: matrix reader reproduces APG per-type breakdown AND grand totals,
// for all three floors, from the locked text-item fixture.
import { parseMatrix } from '../public/lib/matrix-schedule.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };

const items=JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json'));
const exp=JSON.parse(fs.readFileSync('fixtures/apg-matrix-expected.json'));
const byFloor={}; for(const p of items) byFloor[p.floor]=p.items;

for(const floor of ['first_floor','second_floor','third_floor_bid']){
  console.log(`\n${floor}:`);
  const e=exp[floor];
  const r=parseMatrix(byFloor[floor]);
  // grand total
  ok(r.grand_total===e.grand_total, `grand_total ${r.grand_total} == ${e.grand_total}`);
  // per-type sum ties to grand total
  ok(r.ties, `per-type sum ${r.total} ties grand_total (no SF1 trap)`);
  // every expected type present with exact count
  const got=Object.fromEntries(r.rows.map(x=>[x.type,x.quantity]));
  let allMatch=true;
  for(const [t,q] of Object.entries(e.by_type_outlet_qty)){
    if(got[t]!==q){ allMatch=false; console.log(`     miss: ${t} got ${got[t]} want ${q}`); }
  }
  ok(allMatch, `all ${Object.keys(e.by_type_outlet_qty).length} per-type counts exact`);
}
console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, matrix reader reproduces APG`:`${fail} FAILED`));
process.exit(fail?1:0);
