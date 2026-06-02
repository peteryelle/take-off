// LIVE-WIRE gate: the three locked fixtures route correctly through
// buildDeviceList (the real pipeline entry) and reconcile to the locked counts.
import { buildDeviceList } from './public/lib/pipeline.js';
import fs from 'fs';
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;console.log('  PASS ',msg);} else {fail++;console.log('  FAIL ',msg);} };
const norm=s=>String(s).trim().toUpperCase();

// ---- APG quantity_matrix: route -> matrix -> reconcile, count == 113 (first floor) ----
console.log('APG first_floor -> quantity_matrix:');
{
  const ff=JSON.parse(fs.readFileSync('fixtures/apg-matrix-textitems.json')).find(p=>p.floor==='first_floor').items;
  const textItems=ff.map(it=>({str:it.str,x:it.cx_norm,y:it.cy_norm,cx_norm:it.cx_norm,cy_norm:it.cy_norm}));
  // device types: one per outlet type code (label-less; matrix supplies count)
  const deviceTypes=['1','3','4','A','B','SF1','TV'].map(t=>({name:t,detection_config:{type:t,anchor:t,anchor_mode:'exact',sources:['schedule']}}));
  const sheetSignals={ tables:[{ headers:['OUTLET TYPE','OUTLET QUANTITY','POTS/POTN QUANTITY','BLANK QUANTITY'], hasGrandTotalRow:true, idColumnValues:['1','3','4','A','B','SF1','TV'] }], anchorTokenCount:0 };
  const r=buildDeviceList(textItems, deviceTypes, null, { sheetSignals }, [], []);
  ok(r.archetype==='quantity_matrix', `archetype=${r.archetype}`);
  ok(r.routeInfo && r.routeInfo.matrix && r.routeInfo.matrix.ties, `matrix ties grand_total (${r.routeInfo?.matrix?.total}==${r.routeInfo?.matrix?.grand_total})`);
  ok(r.devices.length===113, `reconciled device count ${r.devices.length} == 113`);
}

// ---- VA label_stamp: route -> labels drive count, N# == 93 ----
console.log('VA p5 -> label_stamp:');
{
  const va=JSON.parse(fs.readFileSync('fixtures/va-labelstamp-textitems.json')).items;
  const textItems=va.map(it=>({str:it.str,x:it.cx_norm,y:it.cy_norm,cx_norm:it.cx_norm,cy_norm:it.cy_norm}));
  const nCount=va.filter(it=>/^N\d+$/.test(it.str)).length;
  // N# primary anchor with DV#-DD#-N# family collapse
  const deviceTypes=[{name:'N',detection_config:{type:'N',anchor:'N2',anchor_mode:'exact',families:['DV','DD'],sources:['label']}}];
  const sheetSignals={ tables:[], anchorTokenCount:nCount };
  const r=buildDeviceList(textItems, deviceTypes, null, { sheetSignals, coordKeyDecimals:4 }, [], []);
  ok(r.archetype==='label_stamp', `archetype=${r.archetype} (anchors=${nCount})`);
  // count of N-type devices reconciled
  const nDevices=r.devices.filter(d=>d.type==='N').length;
  ok(nDevices===93, `reconciled N# device count ${nDevices} == 93`);
}

console.log('\n'+(fail===0?`ALL PASS — ${pass} assertions, archetypes route live through buildDeviceList`:`${fail} FAILED`));
process.exit(fail?1:0);
