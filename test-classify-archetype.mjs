// Gate: the archetype classifier routes all three locked fixtures correctly.
import { classifySheet, classifyTable } from './public/lib/classify-archetype.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };

// Self-contained: derive classifier inputs from the locked fixtures (no /tmp).
function deriveSheets() {
  const apg = JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json'))[0];
  const apgSheet = { tables: [{
    headers: ['OUTLET TYPE','OUTLET QUANTITY','POTS/POTN QUANTITY','NIPR-DATA / NIPR-VOIP QUANTITY','BLANK QUANTITY'],
    hasGrandTotalRow: apg.items.some((i) => /grand/i.test(i.str)),
    idColumnValues: ['1','3','4','A','B','SF1','TV'],
  }], anchorTokenCount: 0 };

  const qts = JSON.parse(fs.readFileSync('fixtures/qts-schedule-textitems.json'));
  const qtsUINs = [];
  for (const pg of qts) for (const it of pg.items)
    if (/^CAM-[A-Z0-9]+-[A-Z0-9]+$/.test(it.str.toUpperCase())) qtsUINs.push(it.str.toUpperCase());
  const qtsSheet = { tables: [{
    headers: ['UIN','DEVICE','HEIGHT','DETAIL SHEET','CABLE'],
    hasGrandTotalRow: false,
    idColumnValues: qtsUINs.slice(0, 300),
  }], anchorTokenCount: 0 };

  const va = JSON.parse(fs.readFileSync('fixtures/va-labelstamp-textitems.json'));
  const nCount = va.items.filter((i) => /^N\d+$/.test(i.str)).length;
  const vaSheet = { tables: [], anchorTokenCount: nCount };

  return { apgSheet, qtsSheet, vaSheet, nCount, qtsUINcount: qtsUINs.length };
}
const S = deriveSheets();

console.log('APG -> quantity_matrix / matrix_reader');
const apg=classifySheet(S.apgSheet);
ok(apg.archetype==='quantity_matrix', `archetype=${apg.archetype}`);
ok(apg.route==='matrix_reader', `route=${apg.route}`);

console.log('QTS -> device_list / device_list_reader');
const qts=classifySheet(S.qtsSheet);
ok(qts.archetype==='device_list', `archetype=${qts.archetype}`);
ok(qts.route==='device_list_reader', `route=${qts.route}`);

console.log('VA -> label_stamp / detect_anchor_count');
const va=classifySheet(S.vaSheet);
ok(va.archetype==='label_stamp', `archetype=${va.archetype} (anchors=${S.nCount})`);
ok(va.route==='detect_anchor_count', `route=${va.route}`);

console.log('Negative: empty sheet -> unknown/review (no silent guess)');
const empty=classifySheet({ tables:[], anchorTokenCount:0 });
ok(empty.archetype==='unknown' && empty.route==='review', `archetype=${empty.archetype} route=${empty.route}`);

console.log('Negative: a notes-prose "table" (no id, no qty, no total) -> unknown');
const prose=classifyTable({ headers:['GENERAL','NOTES','OUTLET','CABLE'], idColumnValues:[] });
ok(prose.archetype==='unknown', `archetype=${prose.archetype}`);

console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, 3 archetypes route correctly`:`${fail} FAILED`));
process.exit(fail?1:0);
