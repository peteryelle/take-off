// test-stamp-collapse.mjs — gate: N identical no-UIN stamps must yield N devices.
//
// Regression guard for the camera "180" collapse. A stamp type — every label the
// identical token, counted by position — MUST stay exact/no-UIN. If it is ever
// configured anchor_mode:'regex', detect.js assigns the constant matched token as the
// UIN and reconcile joins all instances into ONE device, silently crushing the count
// (cameras went 19 -> 1/4 this way). This locks the invariant against the real 19
// camera stamps on VA sheet 01TN100Ba (BLDG 01 - LEVEL 00B - AREA A).
//
// Pure: no PDF / DOM / network. Run: node test-stamp-collapse.mjs

import { detectLabels } from './public/lib/detect.js';
import { reconcile }    from './public/lib/reconcile.js';

// 19 real camera-stamp positions (normalized) lifted from the locked sheet.
const STAMPS = [
  [0.5833, 0.7596], [0.6106, 0.7012], [0.5900, 0.5560], [0.4638, 0.1208], [0.4606, 0.1969],
  [0.4690, 0.1742], [0.4744, 0.2050], [0.5037, 0.2310], [0.4800, 0.2214], [0.4930, 0.3634],
  [0.4650, 0.3566], [0.5087, 0.3339], [0.5624, 0.3482], [0.5521, 0.4009], [0.5606, 0.5248],
  [0.5388, 0.6050], [0.5792, 0.6283], [0.4750, 0.6889], [0.4505, 0.6911],
];
const N = STAMPS.length;                                  // 19
const CAM = 'SECURITY ACCESS, VIDEO CAMERA WITH LENS';
const textItems = STAMPS.map(([x, y]) => ({ str: '180', cx_norm: x, cy_norm: y }));

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : 'FAIL '} ${msg}`); if (!cond) fail++; };

// ── correct config: exact / no-UIN → all N stamps survive ──────────────────
const exactCfg = { name: CAM, anchor: '180', anchor_mode: 'exact', families: [], sources: ['label'] };
const inst = detectLabels(textItems, exactCfg);
ok(inst.length === N,                 `detect yields ${N} instances (got ${inst.length})`);
ok(inst.every((i) => i.uin === null), `every stamp instance is no-UIN (uin === null)`);
const recs = reconcile({ [CAM]: { sources: ['label'] } }, inst, [], [], {});
ok(recs.length === N,                 `reconcile preserves ${N} devices (got ${recs.length})`);

// ── tripwire: the regex/UIN misconfiguration MUST be shown to collapse ─────
// This is the exact trap that bit cameras. If it ever stops collapsing, the
// detect/reconcile contract changed — confirm that is intentional before editing.
const regexCfg = { name: CAM, anchor: '180', anchor_mode: 'regex', uin_pattern: '^180$', families: [], sources: ['label'] };
const rInst = detectLabels(textItems, regexCfg);
const rRecs = reconcile({ [CAM]: { sources: ['label'] } }, rInst, [], [], {});
ok(rInst.every((i) => i.uin === '180'), `regex mode assigns the constant token as UIN (the trap)`);
ok(rRecs.length === 1,                  `regex/UIN config collapses ${N} stamps -> 1 (why exact is required)`);

console.log(fail ? `\nFAILED (${fail})` : `\nPASS — ${N} identical stamps stay ${N}`);
process.exit(fail ? 1 : 0);
