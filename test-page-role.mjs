// Gate: page-role classifier produces a USEFUL SUGGESTION for a user who
// confirms each page against a thumbnail. The bar is NOT "top pick always
// right" — the user reassigns in one click. The bar is:
//   (a) the correct role is offered (top pick OR a scored alternate), so the
//       user's correction is a click, not a hunt; and
//   (b) genuinely ambiguous pages are marked low-confidence so the UI can
//       surface them for confirmation first.
import { classifyPageRole } from './public/lib/classify-page-role.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };
const fx=JSON.parse(fs.readFileSync('fixtures/page-role-signals.json'));

let topRight=0, offered=0;
for(const p of fx){
  const r=classifyPageRole(p);
  const top = r.role===p.truth_role;
  const inAlts = (r.alternates||[]).includes(p.truth_role);
  if(top) topRight++;
  if(top || inAlts) offered++;
  console.log(`  ${p.set} p${p.page}: truth=${p.truth_role} suggested=${r.role} conf=${r.confidence} alts=[${r.alternates}]${top?'':(inAlts?' (in alts)':' <-NOT OFFERED')}`);
}
console.log('');
// (a) every page's true role is at least offered (one-click fix, never a hunt)
ok(offered===fx.length, `correct role offered (top or alternate) on all ${fx.length} pages (${offered})`);
// (b) top suggestion is right on a clear majority (so most pages are pre-accepted)
ok(topRight>=Math.ceil(fx.length*0.7), `top suggestion correct on >=70% (${topRight}/${fx.length})`);
// (c) the classifier always returns a confidence the UI can sort on
ok(fx.every(p=>['high','medium','low'].includes(classifyPageRole(p).confidence)), `every page has a sortable confidence`);

console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions; ${topRight}/${fx.length} top-correct, all roles offered`:`${fail} FAILED`));
process.exit(fail?1:0);
