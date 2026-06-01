// test-symbol-fold.mjs — Step 7 gate (reconcile-side).
// Symbols feed reconcile's SNAP: bare/unlabeled glyphs fold onto same-type placed
// devices (no new record, gain a 'symbol' source) and genuinely unlabeled glyphs
// surface as no_uin-flagged devices. Gate: QTS symbols fold onto the 40, an injected
// unlabeled glyph appears, no double-count. Run: node test-symbol-fold.mjs
import { buildDeviceList } from './public/lib/pipeline.js';
import { reconcile } from './public/lib/reconcile.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

// ── Rebuild the QTS fixture (same as the Step 5 pipeline gate): 40 UINs appear in
//    both the plan and the DETAIL SCHEDULE, reconciling to 40 placed devices. ──────
function qts() {
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const X = { uin: 0.10, detail: 0.30, cab1: 0.55, cab2: 0.75 };
  const items = [];
  let i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      items.push(ti(`${p}-EXT-${k}`, 0.40 + (i % 5) * 0.08, 0.10 + (i % 8) * 0.03));
      i++;
    }
  }
  items.push(ti('DETAIL SCHEDULE', X.uin, 0.50),
             ti('UIN', X.uin, 0.51), ti('DETAIL SHEET', X.detail, 0.51),
             ti('CABLE DEST 1', X.cab1, 0.51), ti('CABLE DEST 2', X.cab2, 0.51));
  i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      const uin = `${p}-EXT-${k}`, y = 0.52 + i * 0.008;
      items.push(ti(uin, X.uin, y), ti(`SE0${(i % 6) + 1}-05`, X.detail, y), ti(`EXTIDF${(i % 6) + 1}`, X.cab1, y));
      i++;
    }
  }
  const scheduleCfg = {
    present: true, locator: "table titled 'DETAIL SCHEDULE'",
    columns: { uin: 'UIN', detail_sheet: 'DETAIL SHEET', cable_dest: ['CABLE DEST 1', 'CABLE DEST 2'] },
    type_from: 'uin_prefix',
  };
  const deviceTypes = Object.keys(spec).map((p) => ({
    id: `dt_${p}`, name: p, legend_id: `LEG_${p}`,
    detection_config: { type: p, anchor: p, anchor_mode: 'regex', uin_pattern: `^${p}-[\\w-]+$`,
                        sources: ['schedule', 'label', 'symbol'], families: [] },
  }));
  return { items, scheduleCfg, deviceTypes, spec };
}

console.log('QTS symbol fold (one glyph per device -> folds onto the 40):');
{
  const { items, scheduleCfg, deviceTypes, spec } = qts();
  const opts = { rowTol: 0.005 };

  // Baseline (Step 5 behavior): no symbols -> 40 placed devices.
  const base = buildDeviceList(items, deviceTypes, scheduleCfg, opts);
  assert(base.devices.length === 40, `baseline reconciles to 40 (got ${base.devices.length})`);

  // A matched glyph sits on each device (same type, same xy) — the realistic case
  // where the symbol detector finds the symbol next to a UIN'd label.
  const symbolsOnEach = base.devices.map((d) => ({ type: d.type, x: d.x, y: d.y }));
  const folded = buildDeviceList(items, deviceTypes, scheduleCfg, opts, symbolsOnEach);

  assert(folded.devices.length === 40, `symbols fold, count unchanged at 40 (got ${folded.devices.length})`);
  assert(JSON.stringify(countBy(folded.devices, (d) => d.type)) === JSON.stringify(spec),
    'by-type split still matches after fold (no double-count of any type)');
  assert(folded.devices.every((d) => d.sources.includes('symbol')),
    "every device gained a 'symbol' source");
  assert(folded.devices.every((d) => d.sources.includes('schedule') && d.sources.includes('label')),
    'schedule + label provenance preserved through the fold');
  assert(folded.devices.every((d) => d.xy_source === 'symbol'),
    'symbol xy wins (xy_source flips to symbol)');
  assert(folded.devices.every((d) => d.uin && !d.flags.includes('no_uin')),
    'folded devices keep their UIN and are not flagged unlabeled');
  const uins = folded.devices.map((d) => d.uin);
  assert(new Set(uins).size === uins.length, 'no two reconciled devices share a UIN');
}

console.log('QTS unlabeled glyph (genuinely no UIN -> surfaces as a flag):');
{
  const { items, scheduleCfg, deviceTypes } = qts();
  const opts = { rowTol: 0.005 };
  const base = buildDeviceList(items, deviceTypes, scheduleCfg, opts);

  const symbolsOnEach = base.devices.map((d) => ({ type: d.type, x: d.x, y: d.y }));
  // One extra CR glyph far from any placed CR device — an unlabeled symbol.
  const orphan = { type: 'CR', x: 0.95, y: 0.95 };
  const withOrphan = buildDeviceList(items, deviceTypes, scheduleCfg, opts, [...symbolsOnEach, orphan]);

  assert(withOrphan.devices.length === 41, `unlabeled glyph appears as +1 device (got ${withOrphan.devices.length})`);
  const flagged = withOrphan.devices.filter((d) => d.flags.includes('no_uin'));
  assert(flagged.length === 1, `exactly one device flagged no_uin (got ${flagged.length})`);
  assert(flagged[0] && flagged[0].uin === null, 'the unlabeled device has uin = null');
  assert(flagged[0] && flagged[0].sources.join() === 'symbol', "unlabeled device's only source is symbol");
  assert(withOrphan.devices.filter((d) => !d.flags.includes('no_uin')).length === 40,
    'the 40 known devices are untouched (no double-count from the orphan)');
}

console.log('snapR radius (isolated reconcile unit — fold inside, flag outside):');
{
  const catalog = { CR: { sources: ['label', 'symbol'] } };
  const labels = [{ uin: 'CR-EXT-1', type: 'CR', x: 0.50, y: 0.50 }];
  const snapR = 0.02;

  const inside = reconcile(catalog, labels, [{ type: 'CR', x: 0.515, y: 0.50 }], [], { snapR });
  assert(inside.length === 1, `glyph within snapR folds -> 1 device (got ${inside.length})`);
  assert(inside[0].sources.includes('symbol') && inside[0].xy_source === 'symbol',
    'in-radius fold adds symbol source and takes symbol xy');

  const outside = reconcile(catalog, labels, [{ type: 'CR', x: 0.60, y: 0.50 }], [], { snapR });
  assert(outside.length === 2, `glyph beyond snapR stays separate -> 2 devices (got ${outside.length})`);
  const orphan = outside.find((d) => d.flags.includes('no_uin'));
  assert(orphan && orphan.uin === null, 'out-of-radius glyph is a no_uin device with uin null');

  const wrongType = reconcile(catalog, labels, [{ type: 'DC', x: 0.50, y: 0.50 }], [], { snapR });
  assert(wrongType.length === 2, 'a different-type glyph at the same point does NOT fold (type-gated)');
}

console.log('schedule-only device adopts a glyph (Tier 2 — place, do not double-count):');
{
  const catalog = { CR: { sources: ['schedule', 'label', 'symbol'] } };
  // A scheduled CR with NO plan label -> seeded unplaced (x:null).
  const sched = [{ uin: 'CR-EXT-1', type: 'CR', attributes: { cable_dest: ['IDF1'] } }];

  // No symbol: the device stays unplaced and flagged needs_placement (unchanged behavior).
  const noSym = reconcile(catalog, [], [], sched, { snapR: 0.02 });
  assert(noSym.length === 1 && noSym[0].x === null && noSym[0].flags.includes('needs_placement'),
    'baseline: unlabeled scheduled device is a single needs_placement row');

  // A CR glyph on the plan -> PLACES that scheduled device, not a second row.
  const oneSym = reconcile(catalog, [], [{ type: 'CR', x: 0.40, y: 0.30 }], sched, { snapR: 0.02 });
  assert(oneSym.length === 1, `glyph places the scheduled device, no second row (got ${oneSym.length})`);
  const d = oneSym[0];
  assert(d.uin === 'CR-EXT-1', 'placed device keeps its schedule UIN');
  assert(d.x === 0.40 && d.y === 0.30 && d.xy_source === 'symbol', 'adopts the glyph xy');
  assert(d.sources.includes('schedule') && d.sources.includes('symbol'), 'sources = schedule + symbol');
  assert(d.flags.includes('placement_inferred') && !d.flags.includes('no_uin') && !d.flags.includes('needs_placement'),
    'flagged placement_inferred, not no_uin / not needs_placement');
  assert(d.confidence === 'medium', 'confidence capped at medium (inferred glyph->UIN binding)');
  assert(Array.isArray(d.attributes.cable_dest) && d.attributes.cable_dest[0] === 'IDF1',
    'schedule routing carried onto the placed device');
}

console.log('more glyphs than unplaced rows (count-safe both directions):');
{
  const catalog = { CR: { sources: ['schedule', 'symbol'] } };
  const sched = [{ uin: 'CR-EXT-1', type: 'CR' }, { uin: 'CR-EXT-2', type: 'CR' }]; // both unlabeled
  const syms = [{ type: 'CR', x: 0.20, y: 0.20 }, { type: 'CR', x: 0.50, y: 0.50 }, { type: 'CR', x: 0.80, y: 0.80 }];
  const out = reconcile(catalog, [], syms, sched, { snapR: 0.02 });
  assert(out.length === 3, `2 scheduled placed + 1 unlabeled surfaced = 3 (got ${out.length})`);
  assert(out.filter((d) => d.flags.includes('placement_inferred')).length === 2, 'both schedule rows got placed');
  const orphans = out.filter((d) => d.flags.includes('no_uin'));
  assert(orphans.length === 1 && orphans[0].uin === null, 'the 3rd glyph surfaces as one no_uin device');

  // Fewer glyphs than rows: the unmatched row stays needs_placement, schedule count holds.
  const fewer = reconcile(catalog, [], [{ type: 'CR', x: 0.20, y: 0.20 }], sched, { snapR: 0.02 });
  assert(fewer.length === 2, 'one placed, one still needs_placement -> 2 (schedule count preserved)');
  assert(fewer.filter((d) => d.flags.includes('needs_placement')).length === 1, 'the unmatched row stays needs_placement');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
