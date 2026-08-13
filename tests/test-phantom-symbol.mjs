// test-phantom-symbol.mjs — gate: a glyph type with no template must not run a symbol track.
//
// Regression guard for the camera 12-phantom inflation. discover-config must NOT put
// 'symbol' in sources while symbol_template is null: with no template the symbol locator
// has nothing to match and fabricates phantom no_uin instances (cameras went 19 -> 31
// this way). 'symbol' is added by Step 7 together with the template; has_symbol is
// recorded at discovery so Step 7 knows which types to come back for.
//
// Pure: no PDF / DOM / network. Run: node test-phantom-symbol.mjs

import { buildCatalog } from '../public/lib/discover-config.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : 'FAIL '} ${msg}`); if (!cond) fail++; };

// An exact/stamp candidate that HAS a glyph but (as always at discovery) no template yet.
const { types } = buildCatalog(
  [{ name: 'SECURITY ACCESS, VIDEO CAMERA WITH LENS', kind: 'exact', anchor: '180', legend_present: true, has_symbol: true }],
  ['180', '180', '180'],   // a few plan tokens so freq > 0
);
const cfg = types[0].detection_config;

ok(cfg.symbol_template === null,                  `symbol_template is null at discovery (Step 7 fills it)`);
ok(!(cfg.sources || []).includes('symbol'),       `'symbol' is NOT a source while template is null (no phantom track)`);
ok((cfg.sources || []).includes('label'),         `'label' is a source`);
ok(cfg.has_symbol === true,                       `has_symbol recorded true for Step 7 to pick up`);

// A prefix/glyph type must defer 'symbol' the same way until its template exists.
const { types: t2 } = buildCatalog(
  [{ name: 'CAM', kind: 'prefix', anchor: 'CAM', legend_present: true, has_symbol: true }],
  ['CAM-EXT-1', 'CAM-EXT-2'],
);
ok(!(t2[0].detection_config.sources || []).includes('symbol'), `prefix glyph type also defers 'symbol' until template`);

console.log(fail ? `\nFAILED (${fail})` : `\nPASS — no symbol source emitted without a template`);
process.exit(fail ? 1 : 0);
