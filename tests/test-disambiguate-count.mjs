// test-disambiguate-count.mjs — gate for disambiguateByAdjacentCount against a
// real sheet's text layer (fixtures/va-voip-wall-disambiguate-t11a.json).
// Reproduces the exact split found in the current VOIP-WALL device_types:
// base "VOIP-WALL MNT" (anchor "W") vs. variant "VOIP-WALL MNT 2 PORT"
// (disambiguate_from: base.id, no anchor of its own).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectLabels, disambiguateByAdjacentCount } from '../public/lib/detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/va-voip-wall-disambiguate-t11a.json'), 'utf8'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!ok) failures++;
}

const BASE_ID = 93;
const VARIANT_ID = 97;
const deviceTypes = [
  { id: BASE_ID, name: 'VOIP-WALL MNT', detection_config: { anchor: 'W', anchor_mode: 'exact', type: 'VOIP-WALL MNT' } },
  { id: VARIANT_ID, name: 'VOIP-WALL MNT 2 PORT', detection_config: { disambiguate_from: BASE_ID, type: 'VOIP-WALL MNT 2 PORT' } },
];

const baseInstances = detectLabels(fixture.text_items, deviceTypes[0].detection_config);
check('base detectLabels finds every W anchor (bare + split-compound)', baseInstances.length, fixture.expected.total_w_anchors);

const result = disambiguateByAdjacentCount(fixture.text_items, baseInstances, deviceTypes);
const reclassified = result.filter((i) => i.type === 'VOIP-WALL MNT 2 PORT');
const unchanged = result.filter((i) => i.type === 'VOIP-WALL MNT');

check('reclassified to 2 PORT variant', reclassified.length, fixture.expected.reclassified_to_2_port);
check('unchanged base instances', unchanged.length, fixture.expected.unchanged_base);
check('total instances preserved (no drops, no dupes)', result.length, fixture.expected.total_w_anchors);
check('no false flags on this fixture (2-port variant IS configured)', (result.flaggedCandidates || []).length, 0);

// Regression guard: without a configured variant, matched counts must be flagged,
// never silently dropped or silently left as the base type without a trace.
const noVariantResult = disambiguateByAdjacentCount(
  fixture.text_items, baseInstances,
  [deviceTypes[0], { id: VARIANT_ID, name: 'VOIP-WALL MNT 3 PORT', detection_config: { disambiguate_from: BASE_ID, type: 'VOIP-WALL MNT 3 PORT' } }]
);
check('unmatched count (2) with only a 3-port variant configured gets flagged', (noVariantResult.flaggedCandidates || []).length, fixture.expected.reclassified_to_2_port);
check('unmatched count instances stay as base type (not dropped)', noVariantResult.filter((i) => i.type === 'VOIP-WALL MNT').length, fixture.expected.total_w_anchors);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
