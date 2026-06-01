// Gates the build_device integration: per-instance nearby_text -> discoverCatalog
// -> detection_config, mirroring actionBuildDevice's aggregation + augment.
import { discoverCatalog } from './public/lib/discover-config.js';

let fail = 0;
const assert = (c, m) => { if (c) console.log('  PASS ', m); else { console.log('  FAIL  ', m); fail++; } };

// Mirror actionBuildDevice: dedup nearby_text for the candidate, keep dups for freq,
// then apply the same augment the server applies after discoverCatalog.
function buildDeviceDerive(name, instances, opts = {}) {
  const allNearbyText  = [...new Set(instances.flatMap(i => i.nearby_text || []))];
  const planTokensFlat = instances.flatMap(i => i.nearby_text || []);
  const { types } = discoverCatalog([{
    name, nearby_text: allNearbyText, legend_name: name,
    legend_present: true, approximate_count: instances.length,
    has_symbol: !!opts.has_symbol,
  }], planTokensFlat, null);
  const dc = types[0]?.detection_config || null;
  if (dc) {
    dc.cluster_pt = 25;
    dc.source = 'discovery';
    dc.leader_from_anchor = (dc.families || []).length > 0;
  }
  return dc;
}

console.log('build_device -> detection_config derivation:');

// 93 N2 outlets — each carries the constant "N2" plus a DV/DD/N variant
const n2Instances = [];
for (let i = 1; i <= 93; i++) n2Instances.push({ nearby_text: ['N2', `DV${i}`, `DD${i}`, `N${i}`] });
const n2 = buildDeviceDerive('OUTLET: DUPLEX', n2Instances);
assert(n2.anchor === 'N2' && n2.anchor_mode === 'exact', `N2 anchor/exact (got ${n2.anchor}/${n2.anchor_mode})`);
assert(['DV','DD','N'].every(f => (n2.families || []).includes(f)), `families incl DV/DD/N (got ${JSON.stringify(n2.families)})`);
assert(n2.leader_from_anchor === true, 'N2 leader_from_anchor true (family-bearing outlet)');
assert(n2.cluster_pt === 25 && n2.source === 'discovery', 'augment: cluster_pt 25 + source discovery');

// 11 WAP — standalone, no trailing text
const wap = buildDeviceDerive('WAP', Array.from({ length: 11 }, () => ({ nearby_text: ['WAP'] })), { has_symbol: true });
assert(wap.anchor === 'WAP' && (wap.families || []).length === 0, `WAP anchor / no families (got ${wap.anchor}/${JSON.stringify(wap.families)})`);
assert(wap.leader_from_anchor === false, 'WAP leader_from_anchor false (standalone)');

// 7 camera-180 — standalone numeric label
const cam = buildDeviceDerive('camera 180', Array.from({ length: 7 }, () => ({ nearby_text: ['180'] })), { has_symbol: true });
assert(cam.anchor === '180' && (cam.families || []).length === 0, `180 anchor / no families (got ${cam.anchor}/${JSON.stringify(cam.families)})`);
assert(cam.leader_from_anchor === false, '180 leader_from_anchor false (standalone)');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
