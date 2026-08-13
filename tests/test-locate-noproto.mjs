import { planSymbolDetection, blobsToInstances } from '../public/lib/locate.js';
import { groupSubpaths } from '../public/lib/geometry.js';
import { readFileSync } from 'node:fs';
let ok = true;
const A = (c,m)=>{ console.log((c?'PASS':'FAIL')+' '+m); ok = ok && c; };

// Camera template: fill + lens_tokens map, NO prototypes (the de-prototyped config)
const tmpl = { fill_rgb:[255,87,87], fill_tol:48, body_area:2e-5, aspect_hub_max:2.2,
  lens_tokens: { '1-lens':'cam_1lens', '3-lens':'cam_3lens', '4-lens':'cam_4lens' } };
const symTypes = [
  { id:64, name:'1 Lens Camera', detection_config:{ symbol_template: tmpl } },
  { id:65, name:'3 lens camera', detection_config:{ symbol_template: tmpl } },
  { id:62, name:'4 lens camera', detection_config:{ symbol_template: tmpl } },
];
const steps = planSymbolDetection({ vector_geometry:true }, symTypes);
A(steps.length===1 && steps[0].route==='vector', `one vector step (got ${JSON.stringify(steps.map(s=>s.route))})`);
A(steps[0]?.device_type_ids?.length===3, 'all 3 camera types in the vector step');
A(steps[0]?.group?.prototypes===null, 'group prototypes:null');
A(JSON.stringify(steps[0]?.group?.lens_tokens)===JSON.stringify(tmpl.lens_tokens), 'group carries lens_tokens');

const fx = JSON.parse(readFileSync('fixtures/qts-cameras-subpaths.json'));
const blobs = groupSubpaths(fx.subpaths, { bodyArea:2e-5 });
const inst = blobsToInstances(blobs, steps[0].group);
const tally = {}; inst.forEach(i=>tally[i.type]=(tally[i.type]||0)+1);
const flagged = inst.filter(i=>i.flag).length;
console.log('   tally:', JSON.stringify(tally), 'flagged:', flagged, 'via:', [...new Set(inst.map(i=>i.via))]);
A(tally['cam_1lens']===11 && tally['cam_3lens']===2 && tally['cam_4lens']===4, 'split == 11/2/4 with cam_* tokens');
A(inst.length===17, 'total == 17');
A(flagged===2, '2 ambiguous hubs flagged');
A(inst.every(i=>i.via==='vector'), 'via=vector on all');
console.log(ok?'\nALL PASS':'\nFAILED'); process.exit(ok?0:1);
