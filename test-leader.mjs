// test-leader.mjs — gate for 1:N leader overrides (estimator-marked clusters).
// One marked cluster of quantity N becomes N device rows (base + N-1 siblings),
// all positioned at distance_from (defaults to the cluster), flagged leader_expanded.
// Run: node test-leader.mjs
import { reconcile } from './public/lib/reconcile.js';
import { buildDeviceList } from './public/lib/pipeline.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

console.log('mark a cluster, quantity 4 -> base + 3 siblings (N rows):');
{
  const catalog = { OUTLET: { sources: ['label'] } };
  const labels = [
    { type: 'OUTLET', x: 0.20, y: 0.20, families: ['DV', 'DD'] },  // the leader callout (marked)
    { type: 'OUTLET', x: 0.50, y: 0.50, families: ['N'] },
    { type: 'OUTLET', x: 0.80, y: 0.80 }
  ];
  const base = reconcile(catalog, labels, [], [], {});
  assert(base.length === 3, `baseline 3 outlets (got ${base.length})`);

  const out = reconcile(catalog, labels, [], [], {}, [{ type: 'OUTLET', at: [0.20, 0.20], quantity: 4 }]);
  assert(out.length === 6, `3 - 1 + 4 = 6 devices (got ${out.length})`);

  const group = out.filter((d) => d.attributes.leader_group);
  assert(group.length === 4, `the marked cluster expands to 4 rows (got ${group.length})`);
  assert(group.every((d) => d.flags.includes('leader_expanded')), 'every group member flagged leader_expanded');
  assert(group.every((d) => d.x === 0.20 && d.y === 0.20), 'all group members sit at the cluster (default distance_from)');
  assert(group.every((d) => d.xy_source === 'leader'), 'xy_source = leader');
  assert(group.every((d) => (d.attributes.families || []).includes('DV') && d.attributes.families.includes('DD')),
    'siblings inherit the base families (DV, DD)');
  assert(group.every((d) => d.confidence === 'medium'), 'group confidence = medium (position approximate)');
  assert(group.filter((d) => d.uin === null).length >= 3, 'synthetic siblings expose uin = null');
  assert(out.filter((d) => !d.attributes.leader_group).length === 2, 'the two unmarked outlets are untouched');
}

console.log('distance_from override moves the whole group to the reference:');
{
  const catalog = { OUTLET: { sources: ['label'] } };
  const labels = [{ type: 'OUTLET', x: 0.20, y: 0.20, families: ['DV'] }];
  const out = reconcile(catalog, labels, [], [], {},
    [{ type: 'OUTLET', at: [0.20, 0.20], quantity: 3, distance_from: [0.05, 0.05] }]);
  assert(out.length === 3, `1 - 1 + 3 = 3 (got ${out.length})`);
  assert(out.every((d) => d.x === 0.05 && d.y === 0.05), 'base + siblings all measure from the override reference');
}

console.log('marked centroid matches no device -> honor quantity, flag unmatched:');
{
  const catalog = { OUTLET: { sources: ['label'] } };
  const labels = [{ type: 'OUTLET', x: 0.20, y: 0.20 }];
  const out = reconcile(catalog, labels, [], [], {},
    [{ type: 'OUTLET', at: [0.95, 0.95], quantity: 3, families: ['DV'] }]);
  assert(out.length === 4, `1 untouched + 3 synthetic = 4 (got ${out.length})`);
  const grp = out.filter((d) => d.attributes.leader_group);
  assert(grp.length === 3, '3 synthetic group rows created');
  assert(grp.every((d) => d.flags.includes('leader_unmatched') && d.flags.includes('leader_expanded')),
    'flagged leader_unmatched + leader_expanded');
  assert(grp.every((d) => d.uin === null && d.x === 0.95), 'positioned at the reference, uin null');
}

console.log('end-to-end via buildDeviceList (VA-style N2 outlets):');
{
  const items = [];
  for (let n = 0; n < 10; n++) {
    const x = parseFloat((0.10 + n * 0.07).toFixed(4)), y = 0.30;
    items.push(ti('N2', x, y), ti('DV1', x + 0.004, y));
  }
  const deviceTypes = [{
    id: 'dt_outlet', name: 'OUTLET: DUPLEX', legend_id: 'LEG_OUT',
    detection_config: { anchor: 'N2', anchor_mode: 'exact', families: ['DV', 'DD', 'N'], sources: ['label'] },
  }];

  const baseline = buildDeviceList(items, deviceTypes, { present: false });
  assert(baseline.devices.length === 10, `baseline 10 outlets (got ${baseline.devices.length})`);

  // Mark the first outlet's cluster as a 1:4 leader.
  const marked = baseline.devices[0];
  const out = buildDeviceList(items, deviceTypes, { present: false }, {}, [],
    [{ type: 'OUTLET: DUPLEX', at: [marked.x, marked.y], quantity: 4 }]);
  assert(out.devices.length === 13, `10 - 1 + 4 = 13 (got ${out.devices.length})`);
  assert(out.devices.filter((d) => d.flags.includes('leader_expanded')).length === 4, '4 rows in the leader group');
}

console.log('no overrides -> identical to before (backward compatible):');
{
  const catalog = { OUTLET: { sources: ['label'] } };
  const labels = [{ type: 'OUTLET', x: 0.2, y: 0.2 }, { type: 'OUTLET', x: 0.4, y: 0.4 }];
  const a = reconcile(catalog, labels, [], [], {});
  const b = reconcile(catalog, labels, [], [], {}, []);
  assert(a.length === 2 && b.length === 2, 'empty/absent overrides leave the list unchanged');
  assert(!b.some((d) => d.flags.includes('leader_expanded')), 'no leader flags when no overrides');
}

console.log('group lands on the anchor x/y, not the clicked point:');
{
  const catalog = { OUTLET: { sources: ['label'] } };
  // Base anchor (the N2 token) is at (0.20, 0.20). The estimator clicks slightly off
  // (the overlay centroid), within match radius. The group must use the anchor, not the click.
  const labels = [{ type: 'OUTLET', x: 0.20, y: 0.20, families: ['DV'] }];
  const out = reconcile(catalog, labels, [], [], {},
    [{ type: 'OUTLET', at: [0.212, 0.207], quantity: 3 }]);  // clicked ~0.013 away, inside 0.02
  assert(out.length === 3, `matched + expanded to 3 (got ${out.length})`);
  assert(out.every((d) => d.x === 0.20 && d.y === 0.20),
    'group sits on the base anchor (0.20,0.20), not the clicked centroid (0.212,0.207)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
