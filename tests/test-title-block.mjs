// Gate: title-block reader on REAL title blocks from the EHRM set (13 pages:
// legend, key plans, zone plans, suffixed zones, OSP overview/zone, TR room,
// schedule, rack, riser). Fixture holds only the title-block region text.
import fs from 'fs';
import { readTitleBlock, readRevision, readLocation, suggestRole, pageTextKey } from '../public/lib/title-block.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/title-blocks.json', import.meta.url)));
const get = (file, page) => {
  const f = fx.find((p) => p.file.startsWith(file) && p.page === page);
  if (!f) throw new Error(`fixture missing: ${file} p${page}`);
  return readTitleBlock(f.items, f.file);
};

const EXPECT = [
  ['T-001-TELECOM-LEGEND', 1, { sheet_number: 'T-001', suggested_role: 'legend', rev_label: 'Rev.1' }],
  ['T1.1.JLM', 1, { sheet_number: 'T1.1.JLM', suggested_role: 'plan', building: 'BLDG-01', level: '1', zone: 'J,L,M' }],
  ['T1.5.-01-MASTER', 7, { sheet_number: 'T1.5', suggested_role: 'key_plan', level: '5', zone: null }],
  ['T1.5.-01-MASTER', 8, { sheet_number: 'T1.5.K', suggested_role: 'plan', level: '5', zone: 'K' }],
  ['T1.B-BLDG-01-MASTER', 7, { sheet_number: 'T1.B', suggested_role: 'key_plan', level: 'B' }],
  ['T1.B-BLDG-01-MASTER', 8, { sheet_number: 'T1.B.JM', suggested_role: 'plan', level: 'B', zone: 'J&M' }],
  ['T1.1-G-Z-MASTER', 3, { sheet_number: 'T1.1.Z', suggested_role: 'plan', level: '1', zone: 'Z' }],
  ['T-100', 1, { sheet_number: 'T-100', suggested_role: 'osp_overview', rev_label: 'Rev.0' }],
  ['T-108', 1, { sheet_number: 'T-108', suggested_role: 'osp_route', zone: '8' }],
  ['T-401', 1, { sheet_number: 'T-401', suggested_role: 'tr_room' }],
  ['T-500', 1, { sheet_number: 'T-500', suggested_role: 'schedule', building: null }],
  ['T-501', 1, { sheet_number: 'T-501', suggested_role: 'rack', title: 'TELECOM - TYPICAL RACK ELEVATIONS', rev_label: 'Rev.1' }],
  ['T-601', 1, { sheet_number: 'T-601', suggested_role: 'riser' }],
];
for (const [file, page, exp] of EXPECT) {
  const r = get(file, page);
  for (const [k, v] of Object.entries(exp)) ok(r[k] === v, `${file} p${page}: ${k} = ${JSON.stringify(v)} (got ${JSON.stringify(r[k])})`);
}

// Titles never pick up the agency logo text beside the title box.
ok(fx.every((p) => !/Office of|Construction|Facilities/.test(readTitleBlock(p.items, p.file).title || '')), 'no logo text in any title');

// Pure helpers
ok(readRevision('T-500-TELECOM-SCHEDULES-Rev.0.pdf') === 'Rev.0', 'revision from filename');
ok(readRevision('T1.5.-01-MASTER.pdf') === null, 'no revision in filename -> null (user confirms)');
ok(readLocation('BLDG 30 - LV 1,2 - ZONE X - NEW WORK', 'T1.1.X').level === '1,2', 'multi-level title kept as printed');
ok(suggestRole('SITE FIBER ROUTING - ZONE 3').role === 'osp_route', 'site fiber zone -> osp_route');
ok(suggestRole('').confidence === 'low', 'no title -> low confidence');

// Fingerprint: same text split into different runs (combined PDF vs single-sheet
// export, seen on T1.5.K) must give the same key; changed text must not.
const one = [{ s: 'DATA OUTLET LOCATIONS INDICATED ON THIS SHEET ARE APPROXIMATE' }];
const split = [{ s: 'DATA OUTLET LOCATIONS INDICATED ON THIS SHEET AR' }, { s: 'E APPROXIMATE' }];
ok(pageTextKey(one) === pageTextKey(split), 'fingerprint ignores how text is split into runs');
ok(pageTextKey(one) !== pageTextKey([{ s: 'DATA OUTLET LOCATIONS INDICATED ON THIS SHEET ARE APPROXIMATE 2D' }]), 'fingerprint changes when text is added');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
