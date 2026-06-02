// Gate step 2: buildRoute writes the persistable route per fixture, and
// buildDeviceList honors a STORED route (the discovery round-trip) to the
// locked counts — no re-derivation at call time.
import { buildRoute, CLASSIFIER_VERSION } from './public/lib/classify-archetype.js';
import { deriveSheetSignals, buildDeviceList } from './public/lib/pipeline.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };
const toItems=arr=>arr.map(it=>({str:it.str,x:it.cx_norm,y:it.cy_norm,cx_norm:it.cx_norm,cy_norm:it.cy_norm}));

console.log('APG: buildRoute -> quantity_matrix, stored route -> 113');
{
  const ff=JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json')).find(p=>p.floor==='first_floor').items;
  const textItems=toItems(ff);
  const deviceTypes=['1','3','4','A','B','SF1','TV'].map(t=>({name:t,detection_config:{type:t,anchor:t,anchor_mode:'exact',sources:['schedule']}}));
  const signals=deriveSheetSignals(textItems, deviceTypes);
  const route=buildRoute(signals);                       // what discovery persists
  ok(route.archetype==='quantity_matrix', `route.archetype=${route.archetype}`);
  ok(route.route==='matrix_reader', `route.route=${route.route}`);
  ok(route.classifier_version===CLASSIFIER_VERSION, `version stamped ${route.classifier_version}`);
  ok(typeof route.classified_at==='string', `classified_at present`);
  // pipeline reads the STORED route (no sheetSignals, no derive)
  const r=buildDeviceList(textItems, deviceTypes, null, { route }, [], []);
  ok(r.archetype==='quantity_matrix' && r.routeInfo.source==='stored', `pipeline used stored route`);
  ok(r.devices.length===113, `stored-route device count ${r.devices.length} == 113`);
}

console.log('VA: buildRoute -> label_stamp, stored route -> 93');
{
  const va=JSON.parse(fs.readFileSync('fixtures/va-labelstamp-textitems.json')).items;
  const textItems=toItems(va);
  const deviceTypes=[{name:'N',detection_config:{type:'N',anchor:'N2',anchor_mode:'exact',families:['DV','DD'],sources:['label']}}];
  const route=buildRoute(deriveSheetSignals(textItems, deviceTypes));
  ok(route.archetype==='label_stamp', `route.archetype=${route.archetype}`);
  ok(route.signals.anchorTokenCount===93, `route.signals.anchorTokenCount=${route.signals.anchorTokenCount}`);
  const r=buildDeviceList(textItems, deviceTypes, null, { route, coordKeyDecimals:4 }, [], []);
  const n=r.devices.filter(d=>d.type==='N').length;
  ok(r.routeInfo.source==='stored' && n===93, `stored-route N# count ${n} == 93`);
}

console.log('Unknown sheet -> route=review (persisted escalation)');
{
  const route=buildRoute({ tables:[], anchorTokenCount:0 });
  ok(route.archetype==='unknown' && route.route==='review', `route=${route.route}`);
}

console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, route persists and pipeline honors it`:`${fail} FAILED`));
process.exit(fail?1:0);
