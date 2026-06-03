// Gate: symbol (camera) types map their token -> device_types row so device_type_id
// resolves for BOM. Regression guard for the typeMap loop that used to skip no-anchor types.
import { buildDeviceList } from './public/lib/pipeline.js';
let fail = 0; const A = (c,m)=>{ console.log((c?'  PASS ':'  FAIL ')+m); if(!c) fail++; };
const tmpl = { fill_rgb:[255,87,87], fill_tol:48, body_area:2e-5,
  lens_tokens:{'1-lens':'cam_1lens','3-lens':'cam_3lens','4-lens':'cam_4lens'} };
const deviceTypes = [
  { id:64, name:'1 Lens Camera', detection_config:{ sources:['symbol'], symbol_token:'cam_1lens', symbol_template:tmpl } },
  { id:65, name:'3 lens camera', detection_config:{ sources:['symbol'], symbol_token:'cam_3lens', symbol_template:tmpl } },
  { id:62, name:'4 lens camera', detection_config:{ sources:['symbol'], symbol_token:'cam_4lens', symbol_template:tmpl } },
];
const symbolInstances = [
  { type:'cam_1lens', x:0.10, y:0.10, confidence:'high', via:'vector' },
  { type:'cam_3lens', x:0.20, y:0.20, confidence:'high', via:'vector' },
  { type:'cam_4lens', x:0.30, y:0.30, confidence:'high', via:'vector' },
];
const { devices, typeMap } = buildDeviceList([], deviceTypes, null, {}, symbolInstances, []);
A(typeMap['cam_1lens']?.id===64, 'cam_1lens -> type 64');
A(typeMap['cam_3lens']?.id===65, 'cam_3lens -> type 65');
A(typeMap['cam_4lens']?.id===62, 'cam_4lens -> type 62');
A(devices.length===3, `3 camera devices reconciled (got ${devices.length})`);
A(devices.every(d => typeMap[d.type]?.id), 'every device type resolves to a device_types id (device_type_id will not be null)');
console.log(fail?`\n${fail} FAILED`:'\nall PASS'); process.exit(fail?1:0);
