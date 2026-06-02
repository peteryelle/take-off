import { reconcile } from './public/lib/reconcile.js';
let ok = true;
// 1) two cam_1lens symbols 0.012 apart, no labels/schedule, no catalog -> must stay 2
const d1 = reconcile({}, [], [
  { type:'cam_1lens', x:0.346, y:0.358 },
  { type:'cam_1lens', x:0.334, y:0.358 },
], []);
const cams = d1.filter(d=>d.type==='cam_1lens');
console.log('distinct no-uin within snapR ->', cams.length, cams.length===2 ? 'PASS' : 'FAIL (merged!)');
ok = ok && cams.length===2;
// 2) a symbol SHOULD still corroborate a labeled device at ~same spot (fold -> 1, two sources)
const d2 = reconcile({ CR:{ sources:['label','symbol'] } },
  [{ type:'CR', x:0.50, y:0.50, uin:'CR-1', raw_labels:['CR-1'] }],
  [{ type:'CR', x:0.505, y:0.50 }], []);
const crs = d2.filter(d=>d.type==='CR');
const folded = crs.length===1 && (crs[0].sources||[]).includes('symbol');
console.log('symbol corroborates labeled device ->', crs.length, folded ? 'PASS' : 'FAIL');
ok = ok && folded;
console.log(ok ? '\nALL PASS' : '\nFAILED'); process.exit(ok?0:1);
