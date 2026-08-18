// test-pipeline-guards.mjs — regression gate for public/lib/pipeline-guards.js.
//
// Both functions here were originally inline in pass-batch.js. The same bug
// class — Number(null) === 0, which passes Number.isFinite, so an unset
// value silently reads as a real "0" instead of falling back — hit that file
// twice in one session (total_ft handling, then the first pass at
// resolveTiaLimit). This gate exists so a third occurrence fails loudly
// instead of shipping.
//
// Run from repo root:  node test-pipeline-guards.mjs
import { hasUsableScale, resolveTiaLimit } from './public/lib/pipeline-guards.js';

let fails = 0;
const eq = (got, want, msg) => {
  if (got !== want) { console.error(`FAIL ${msg}\n  got  ${got}\n  want ${want}`); fails++; }
  else console.log(`ok   ${msg}`);
};

// ── hasUsableScale ──
eq(hasUsableScale({ scale_pts_per_ft: 9 }, null), true, 'existing page scale is usable');
eq(hasUsableScale({ scale_pts_per_ft: null }, null), false, 'no existing scale, no override -> blocked');
eq(hasUsableScale({ scale_pts_per_ft: null }, { paper_value: 0.125, real_value: 1 }), true,
   'valid scale_override unblocks a page with no saved scale');
eq(hasUsableScale({ scale_pts_per_ft: null }, { paper_value: 0.125 }), false,
   'override missing real_value does not count as usable');
eq(hasUsableScale({ scale_pts_per_ft: null }, { paper_value: 0.125, real_value: 0 }), false,
   'override with real_value=0 does not count as usable (would divide by zero downstream)');
eq(hasUsableScale({ scale_pts_per_ft: 0 }, null), false,
   'existing scale of exactly 0 does not count as usable');

// ── resolveTiaLimit ──
eq(resolveTiaLimit(null), 295, 'unset (null) tia_limit_ft falls back to the 295ft default');
eq(resolveTiaLimit(undefined), 295, 'unset (undefined) tia_limit_ft falls back to the 295ft default');
eq(resolveTiaLimit('270.0'), 270, 'numeric-string tia_limit_ft (as returned by Postgres NUMERIC) parses correctly');
eq(resolveTiaLimit(270), 270, 'plain number tia_limit_ft passes through');
eq(resolveTiaLimit(0), 0, 'explicit 0 is honored as a real value, NOT treated as unset — this is the exact bug that shipped and got caught');
eq(resolveTiaLimit(null, 350), 350, 'custom fallback is respected when supplied');
eq(resolveTiaLimit('not-a-number'), 295, 'garbage value falls back rather than propagating NaN');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
