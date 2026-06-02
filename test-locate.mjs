// test-locate.mjs — OFFLINE gate for the symbol locator router (substep 5). Pure: gates
// the routing decision, the blobs->symbol_instances assembly (rule AND prototype paths),
// and the fill-grouping plan, on the frozen QTS fixtures. The live vector extraction is
// gated by test-geometry(-extract); here we gate what's NEW: routing + emission + plan.
// Run: node test-locate.mjs
import { chooseLocator, blobsToInstances, planSymbolDetection } from './public/lib/locate.js';
import { groupSubpaths } from './public/lib/geometry.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};

const subs = JSON.parse(readFileSync(new URL('./fixtures/qts-cameras-subpaths.json', import.meta.url))).subpaths;
const protoFx = JSON.parse(readFileSync(new URL('./fixtures/qts-camera-prototypes.json', import.meta.url)));
const blobs = groupSubpaths(subs, { bodyArea: 2e-5 });
const camGroup = { fill_rgb: protoFx.fill_rgb, fill_tol: protoFx.fill_tol, body_area: protoFx.body_area, prototypes: protoFx.prototypes };

console.log('route decision (vector-first, probe-driven fallback):');
assert(chooseLocator({ vector_geometry: true }, camGroup) === 'vector', 'vector sheet + template -> vector');
assert(chooseLocator({ vector_geometry: false, raster_only: true }, camGroup) === 'llm', 'raster sheet -> llm fallback');
assert(chooseLocator({ vector_geometry: true }, { prototypes: [] }) === 'llm', 'vector sheet but no template -> llm (degrade, behaviour preserved)');
assert(chooseLocator(null, camGroup) === 'llm', 'unknown sheet_class -> llm');

console.log('blobs -> symbol_instances, RULE path (no prototypes) = 4/2/11:');
const ruleInst = blobsToInstances(blobs, {});
const rn = (t) => ruleInst.filter((i) => i.type === t).length;
assert(ruleInst.length === 17, `17 instances (got ${ruleInst.length})`);
assert(rn('1-lens') === 11 && rn('4-lens') === 4 && rn('3-lens') === 2, `4/2/11 (got ${rn('1-lens')}/${rn('4-lens')}/${rn('3-lens')})`);
assert(ruleInst.filter((i) => i.flag === 'verify_lens_count').length === 2, '2 flagged for verify');
assert(ruleInst.every((i) => i.via === 'vector' && i.x >= 0 && i.x <= 1 && i.y >= 0 && i.y <= 1), 'every instance { type, x,y in [0,1], confidence, flag, via:vector }');

console.log('blobs -> symbol_instances, PROTOTYPE path (symbol_template round-trip):');
// The honest invariant: geometry confidently nails the 15 clean cases (11 directional
// 1-lens + 4 symmetric 4-lens) identically to the rule; the 2 genuinely-ambiguous hubs
// are FLAGGED for the human in either classifier. The prototype distance can name a
// flagged hub but cannot make it confident — so the human reviews the same 2 either way.
const protoInst = blobsToInstances(blobs, camGroup);
const confident = protoInst.filter((i) => i.confidence === 'high');
const flagged = protoInst.filter((i) => i.flag === 'verify_lens_count');
const cn = (t) => confident.filter((i) => i.type === t).length;
assert(protoInst.length === 17 && protoInst.every((i) => i.type !== null), 'all 17 matched a prototype (none coerced to no_match)');
assert(confident.length === 15, `15 confident calls (got ${confident.length})`);
assert(cn('1-lens') === 11 && cn('4-lens') === 4, `confident split matches the rule: 11 directional + 4 symmetric (got ${cn('1-lens')}+${cn('4-lens')})`);
assert(flagged.length === 2, `the 2 ambiguous hubs flagged for verification regardless of prototype distance (got ${flagged.length})`);

console.log('plan groups types by fill (locate red once, split into 3 lens types):');
const symTypes = [
  { id: 'c1', name: 'QTS 1-Lens', detection_config: { sources: ['symbol'], symbol_template: camGroup } },
  { id: 'c3', name: 'QTS 3-Lens', detection_config: { sources: ['symbol'], symbol_template: camGroup } },
  { id: 'c4', name: 'QTS 4-Lens', detection_config: { sources: ['symbol'], symbol_template: camGroup } },
  { id: 'wap', name: 'WAP', detection_config: { sources: ['symbol'] } }, // description-only -> llm
];
const planVec = planSymbolDetection({ vector_geometry: true }, symTypes);
const vSteps = planVec.filter((s) => s.route === 'vector');
const lSteps = planVec.filter((s) => s.route === 'llm');
assert(vSteps.length === 1, `one vector locate step for the shared red fill (got ${vSteps.length})`);
assert(vSteps[0].device_type_ids.length === 3, `that step covers all 3 camera types (got ${vSteps[0].device_type_ids.length})`);
assert(lSteps.length === 1 && lSteps[0].device_type_id === 'wap', 'the description-only type routes to llm');

console.log('plan on a raster sheet -> everything falls back to llm:');
const planRas = planSymbolDetection({ vector_geometry: false, raster_only: true }, symTypes);
assert(planRas.every((s) => s.route === 'llm') && planRas.length === 4, `all 4 types -> llm (got ${planRas.filter((s) => s.route === 'llm').length}/4)`);

console.log(`\n${failures === 0 ? 'ALL PASS — locator routes vector-first, assembles 4/2/11 instances, groups by fill, degrades to llm' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
