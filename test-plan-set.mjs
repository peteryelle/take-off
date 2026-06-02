// Gate step 4: the set walker routes each page to the right work, flags the
// cross-sheet double-count risk, and sends low-confidence pages to confirm.
import { planSet, planPage } from './public/lib/plan-set.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };

// Build a realistic mixed APG-like set from the page-role fixture signals,
// attaching real sheetSignals for the schedule/plan pages from the matrix fixture.
const roleFx=JSON.parse(fs.readFileSync('fixtures/page-role-signals.json'));
const apgMatrix=JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json'))[0]; // first_floor items
const matrixSheetSignals={ tables:[{ headers:['OUTLET TYPE','OUTLET QUANTITY','BLANK QUANTITY'], hasGrandTotalRow:true, idColumnValues:['1','3','4','A','B','SF1','TV'] }], anchorTokenCount:0 };
const planSheetSignals={ tables:[], anchorTokenCount:62 };  // a plan stamps anchors, no countable table

// Assemble a set: APG legend(detail), 2 plans, 2 schedules, 1 detail
const get=(set,page)=>roleFx.find(p=>p.set===set&&p.page===page);
const pages=[
  { id:1, pdf_page_number:1,  sheet_title:'PLAN',          roleSignals:get('APG',1),  sheetSignals:planSheetSignals },
  { id:23,pdf_page_number:23, sheet_title:'OUTLET SCHED',  roleSignals:get('APG',23), sheetSignals:matrixSheetSignals },
  { id:25,pdf_page_number:25, sheet_title:'OUTLET SCHED',  roleSignals:get('APG',25), sheetSignals:matrixSheetSignals },
  { id:28,pdf_page_number:28, sheet_title:'DETAILS',       roleSignals:get('APG',28), sheetSignals:{tables:[],anchorTokenCount:0} },
  { id:1.1,pdf_page_number:101,sheet_title:'AE2 LEGEND',   roleSignals:get('AE2',1),  sheetSignals:{tables:[],anchorTokenCount:0} },
  { id:5, pdf_page_number:105, sheet_title:'AE2 PLAN',     roleSignals:get('AE2',5),  sheetSignals:planSheetSignals },
];
const plan=planSet(pages);

console.log('Per-page work:');
for(const p of plan.pages) console.log(`  p${p.pdf_page_number}: role=${p.role}(${p.role_confidence}) work=${p.work}${p.needs_confirm?' [CONFIRM]':''}`);

// APG p1 -> plan -> count_labels (high conf)
ok(plan.pages.find(p=>p.pdf_page_number===1).work==='count_labels', 'APG p1 plan -> count_labels');
// APG p23 schedule (high conf, grand total) -> read_schedule
ok(plan.pages.find(p=>p.pdf_page_number===23).work==='read_schedule', 'APG p23 schedule -> read_schedule');
// APG p25 schedule but LOW confidence -> confirm (user assigns)
ok(plan.pages.find(p=>p.pdf_page_number===25).needs_confirm, 'APG p25 (low conf) -> confirm');
// APG p28 detail -> skip
ok(plan.pages.find(p=>p.pdf_page_number===28).work==='skip', 'APG p28 detail -> skip');
// AE2 p1 legend -> discover
ok(plan.pages.find(p=>p.pdf_page_number===101).work==='discover', 'AE2 p1 legend -> discover');

// Cross-sheet: set has BOTH plans and schedules -> needs reconcile, not sum
ok(plan.cross_sheet.needs_cross_sheet_reconcile===true, 'cross-sheet double-count risk flagged');
ok(plan.cross_sheet.note && /Do not sum both/.test(plan.cross_sheet.note), 'cross-sheet note warns against summing');

// Summary tallies
ok(plan.summary.total===6, `summary total ${plan.summary.total} == 6`);

console.log('\nsummary:', JSON.stringify(plan.summary), '\ncross_sheet:', JSON.stringify(plan.cross_sheet.needs_cross_sheet_reconcile));
console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, set walker routes + flags cross-sheet`:`${fail} FAILED`));
process.exit(fail?1:0);
