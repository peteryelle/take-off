// Gate: note rules read from the real EHRM wording (T-001 note 28, T-108 note 1).
import { findRules, findPhasingSheetRefs, splitNumberedNotes } from '../public/lib/note-rules.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const T001 = `CERTIFICATION OF COMPLETE CAT6A NETWORK LINK FROM OUTLET TO PATCH PANEL. 28. CONTRACTOR SHALL PROVIDE PULL BOXES AS REQUIRED AND SIZED PER ANSI/TIA 569. MAXIMUM SPACING BETWEEN PULL BOXES SHALL NOT EXCEED 100' FOR STRAIGHT CONDUIT RUNS, AND AT A CUMULATIVE MAXIMUM OF 180 DEGREES OF CONDUIT BEND. 29. NETWORK CABLING SHALL BE SEGREGATED FROM ALL OTHER SYSTEMS CABLING. T-002 GENERAL AND PHASING NOTES`;
const T108 = `1. CONDUIT LOCATIONS INDICATED ON THIS PLAN ARE DIAGRAMMATIC. CONTRACTOR TO COORDINATE EXACT CONDUIT ROUTING, MANHOLE AND HANDHOLE PLACEMENT WITH EXISTING FIELD CONDITIONS STRUCTURAL AND CIVIL PLANS PRIOR TO CONSTRUCTION. MAXIMUM CONDUIT LENGTH BETWEEN MANHOLES/HANDHOLES IS NOT TO EXCEED 250' OR CUMULATIVE 180 DEGREES OF CONDUIT BEND. 2. REFER TO FIBER BACKBONE RISER DIAGRAM ON SHEET T-601.`;

ok(splitNumberedNotes(T001).map((n) => n.ref).join() === '28,29', 'splits numbered notes');

const a = findRules(T001, 'T-001');
const aPull = a.find((r) => r.rule_kind === 'pull_limit_ft');
const aBend = a.find((r) => r.rule_kind === 'bend_limit_deg');
ok(aPull && aPull.rule_value === 100 && aPull.used_by_step === 'WF4' && aPull.note_ref === 'T-001 note 28', "T-001 note 28: 100' inside buildings -> WF4");
ok(aBend && aBend.rule_value === 180, 'T-001 note 28: 180 degree bend limit');
ok(a.every((r) => r.note_ref !== 'T-001 note 29'), 'unrelated note 29 ignored');

const b = findRules(T108, 'T-108');
const bPull = b.find((r) => r.rule_kind === 'pull_limit_ft');
ok(bPull && bPull.rule_value === 250 && bPull.used_by_step === 'WF3' && bPull.where === 'outside plant', "T-108 note 1: 250' between manholes/handholes -> WF3");
ok(b.find((r) => r.rule_kind === 'bend_limit_deg')?.rule_value === 180, 'T-108 note 1: 180 degree bend limit');

ok(findPhasingSheetRefs(T001).join() === 'T-002', 'legend points to phasing sheet T-002');
ok(findPhasingSheetRefs(T108).length === 0, 'no phasing reference on T-108');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
