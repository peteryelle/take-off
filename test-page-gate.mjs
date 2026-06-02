import { runnerWorkForRole, unassignedPages } from './public/lib/plan-set.js';
let ok=true; const A=(c,m)=>{console.log((c?'PASS':'FAIL')+' '+m); ok=ok&&c;};

// role -> work
A(runnerWorkForRole('plan')==='count', "plan -> count");
A(runnerWorkForRole('schedule')==='read_schedule', "schedule -> read_schedule");
A(runnerWorkForRole('legend')==='skip', "legend -> skip");
A(runnerWorkForRole('detail')==='skip', "detail -> skip");
A(runnerWorkForRole('skip')==='skip', "skip -> skip");
A(runnerWorkForRole(null)==='needs_role', "null -> needs_role (BLOCK)");
A(runnerWorkForRole(undefined)==='needs_role', "unassigned -> needs_role (BLOCK)");
A(runnerWorkForRole('bogus')==='needs_role', "unknown -> needs_role (BLOCK)");

// all-or-nothing set guard
const all4 = [
  {pdf_page_number:1, page_role:'legend'},
  {pdf_page_number:2, page_role:'schedule'},
  {pdf_page_number:3, page_role:'plan'},
  {pdf_page_number:4, page_role:'detail'},
];
A(unassignedPages(all4).length===0, "fully-assigned set -> clear to run (none missing)");

const oneMissing = [
  {pdf_page_number:1, page_role:'legend'},
  {pdf_page_number:3, page_role:'plan'},
  {pdf_page_number:7, page_role:null},     // unassigned
];
A(JSON.stringify(unassignedPages(oneMissing))==='[7]', "one unassigned -> blocks, names pg7");

const noneAssigned = [{pdf_page_number:5,page_role:null},{pdf_page_number:6,page_role:null}];
A(unassignedPages(noneAssigned).length===2, "none assigned -> all blocked");

console.log(ok?'\nALL PASS':'\nFAILED'); process.exit(ok?0:1);
