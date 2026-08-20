// Gate: single-glyph symbol types (e.g. WAP — no lens classification, just one
// token) map their token -> device_types row so device_type_id resolves for BOM,
// same as the camera symbol_token shape already covers in test-symbol-typemap.mjs.
// Regression guard for the gap where symbol_template.single_type was never
// recognized as a token in buildDeviceList's typeMap loop: blobsToInstances
// already emits candidates keyed by single_type (the single_type bypass that
// skips camera lens-classification), but nothing mapped that key back to a
// device_types row, so those candidates' device_type_id always came back null.
// Confirmed on a real project: 28 WAP candidates persisted with device_type_id
// null before this fix.
import { buildDeviceList } from '../public/lib/pipeline.js';
let fail = 0; const A = (c,m)=>{ console.log((c?'  PASS ':'  FAIL ')+m); if(!c) fail++; };

const tmpl = { single_type: 'WIRELESS ACCESS POINT', fill_rgb:[127,127,127], fill_tol:48, body_area:2e-5 };
const deviceTypes = [
  { id: 94, name: 'WIRELESS ACCESS POINT', detection_config: { sources:['symbol'], anchor: null, symbol_template: tmpl } },
];
const symbolInstances = [
  { type: 'WIRELESS ACCESS POINT', x: 0.10, y: 0.10, confidence: 'high', via: 'vector' },
  { type: 'WIRELESS ACCESS POINT', x: 0.20, y: 0.20, confidence: 'high', via: 'vector' },
];
const { devices, typeMap } = buildDeviceList([], deviceTypes, null, {}, symbolInstances, []);
A(typeMap['WIRELESS ACCESS POINT']?.id === 94, 'single_type token WIRELESS ACCESS POINT -> type 94');
A(devices.length === 2, `2 WAP devices reconciled (got ${devices.length})`);
A(devices.every(d => typeMap[d.type]?.id === 94), 'every device resolves to device_types id 94 (device_type_id will not be null)');

// Mutation tripwire: two single_type device types sharing the SAME token — this
// mirrors the real project's duplicate WAP/WAP rows (ids 87, 91). Last-write-wins
// is the existing, pre-existing behavior for symbol_token too (not a regression
// this fix introduces) — asserted explicitly so a future change that alters this
// ordering assumption trips a visible failure instead of silently drifting.
const dupDeviceTypes = [
  { id: 87, name: 'WAP', detection_config: { sources:['symbol'], anchor: null, symbol_template: { single_type: 'WAP', fill_rgb:[127,127,127] } } },
  { id: 91, name: 'WAP (dup)', detection_config: { sources:['symbol'], anchor: null, symbol_template: { single_type: 'WAP', fill_rgb:[127,127,127] } } },
];
const { typeMap: dupMap } = buildDeviceList([], dupDeviceTypes, null, {}, [], []);
A(dupMap['WAP']?.id === 91, 'duplicate single_type tokens: last-in-array wins (documented, not silently arbitrary)');

console.log(fail?`\n${fail} FAILED`:'\nall PASS'); process.exit(fail?1:0);
