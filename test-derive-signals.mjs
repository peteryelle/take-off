// Gate: deriveSheetSignals produces classifier inputs from the raw text layer,
// and buildDeviceList auto-derives them (no hand-built sheetSignals) to route
// APG->matrix->113 and VA->label_stamp->93. Closes the mocked-signals gap.
import { deriveSheetSignals, buildDeviceList } from './public/lib/pipeline.js';
import { classifySheet } from './public/lib/classify-archetype.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };
const toItems=arr=>arr.map(it=>({str:it.str,x:it.cx_norm,y:it.cy_norm,cx_norm:it.cx_norm,cy_norm:it.cy_norm}));

console.log('APG: derive signals from raw text -> auto-route -> 113');
{
  const ff=JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json')).find(p=>p.floor==='first_floor').items;
  const textItems=toItems(ff);
  const deviceTypes=['1','3','4','A','B','SF1','TV'].map(t=>({name:t,detection_config:{type:t,anchor:t,anchor_mode:'exact',sources:['schedule']}}));
  const sig=deriveSheetSignals(textItems, deviceTypes);
  const cls=classifySheet(sig);
  ok(cls.archetype==='quantity_matrix', `derived signals classify as ${cls.archetype}`);
  // auto-derive path: no sheetSignals passed
  const r=buildDeviceList(textItems, deviceTypes, null, {}, [], []);
  ok(r.archetype==='quantity_matrix', `buildDeviceList auto-routed ${r.archetype}`);
  ok(r.devices.length===113, `auto-routed device count ${r.devices.length} == 113`);
}

console.log('VA: derive signals from raw text -> auto-route -> 93');
{
  const va=JSON.parse(fs.readFileSync('fixtures/va-labelstamp-textitems.json')).items;
  const textItems=toItems(va);
  const deviceTypes=[{name:'N',detection_config:{type:'N',anchor:'N2',anchor_mode:'exact',families:['DV','DD'],sources:['label']}}];
  const sig=deriveSheetSignals(textItems, deviceTypes);
  ok(sig.anchorTokenCount===93, `derived anchorTokenCount ${sig.anchorTokenCount} == 93`);
  const cls=classifySheet(sig);
  ok(cls.archetype==='label_stamp', `derived signals classify as ${cls.archetype}`);
  const r=buildDeviceList(textItems, deviceTypes, null, { coordKeyDecimals:4 }, [], []);
  const nDevices=r.devices.filter(d=>d.type==='N').length;
  ok(r.archetype==='label_stamp' && nDevices===93, `auto-routed ${r.archetype}, N# count ${nDevices} == 93`);
}

console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, signals derived from raw text route correctly`:`${fail} FAILED`));
process.exit(fail?1:0);
