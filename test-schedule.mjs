// schedule.test.js — Step 4 gate. Pure fixture for the QTS DETAIL SCHEDULE.
// Run: node test/schedule.test.js
import { parseSchedule } from './public/lib/schedule.js';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  PASS ', msg);
  else { console.log('  FAIL ', msg); failures++; }
};
const countBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const ti = (str, x, y) => ({ str, cx_norm: x, cy_norm: y });

// Column x-positions for the fixture table.
const X = { uin: 0.10, detail: 0.30, cab1: 0.55, cab2: 0.75 };
const cfg = {
  present: true,
  locator: "table titled 'DETAIL SCHEDULE'",
  columns: { uin: 'UIN', detail_sheet: 'DETAIL SHEET', cable_dest: ['CABLE DEST 1', 'CABLE DEST 2'] },
  type_from: 'uin_prefix',
};

// Build the QTS schedule as a text layer: title, header, 40 data rows.
function qtsScheduleItems({ splitCableHeader = false } = {}) {
  const spec = { CAM: 11, VIC: 10, CR: 7, ACP: 4, DC: 3, KB: 2, ALM: 2, AD: 1 };
  const items = [ti('DETAIL SCHEDULE', X.uin, 0.05) ];

  // header row at y=0.08
  items.push(ti('UIN', X.uin, 0.08), ti('DETAIL SHEET', X.detail, 0.08), ti('CABLE DEST 2', X.cab2, 0.08));
  if (splitCableHeader) {
    // "CABLE DEST 1" split across three adjacent items (real PDF text-layer behavior)
    items.push(ti('CABLE', X.cab1 - 0.03, 0.08), ti('DEST', X.cab1, 0.08), ti('1', X.cab1 + 0.03, 0.08));
  } else {
    items.push(ti('CABLE DEST 1', X.cab1, 0.08));
  }

  // 40 data rows
  let i = 0;
  for (const [p, n] of Object.entries(spec)) {
    for (let k = 1; k <= n; k++) {
      const y = 0.10 + i * 0.015;
      items.push(ti(`${p}-EXT-${k}`, X.uin, y));
      items.push(ti(`SE0${(i % 6) + 1}-05`, X.detail, y));
      items.push(ti(`EXTIDF${(i % 6) + 1}`, X.cab1, y));      // cable dest 1 — always present
      if (i % 3 === 0) items.push(ti(`EXTIDF${((i + 2) % 6) + 1}`, X.cab2, y)); // cable dest 2 — sometimes
      i++;
    }
  }
  // a footer line that must NOT be parsed as a row
  items.push(ti('TOTAL DEVICES: 40', X.uin, 0.10 + i * 0.015 + 0.02));
  return { items, spec };
}

console.log('QTS DETAIL SCHEDULE (single-item headers):');
{
  const { items, spec } = qtsScheduleItems();
  const rows = parseSchedule(items, cfg);
  assert(rows.length === 40, `schedule rows == 40 (got ${rows.length})`);
  assert(rows.every((r) => Array.isArray(r.attributes.cable_dest) && r.attributes.cable_dest.length >= 1),
    'every row has at least one cable destination');
  assert(rows.every((r) => r.attributes.detail_sheet && /SE0\d-05/.test(r.attributes.detail_sheet)),
    'detail_sheet populated on every row');
  const byType = countBy(rows, (r) => r.type);
  assert(JSON.stringify(byType) === JSON.stringify(spec), `type-by-prefix matches ${JSON.stringify(spec)} (got ${JSON.stringify(byType)})`);
  assert(rows.every((r) => /^[A-Z]+-EXT-\d+$/.test(r.uin)), 'every row carries a UIN; footer line excluded');
  const withTwo = rows.filter((r) => r.attributes.cable_dest.length === 2).length;
  assert(withTwo > 0, `rows with two cable dests parsed (${withTwo})`);
}

console.log('QTS DETAIL SCHEDULE (split "CABLE DEST 1" header):');
{
  const { items } = qtsScheduleItems({ splitCableHeader: true });
  const rows = parseSchedule(items, cfg);
  assert(rows.length === 40, `split-header still yields 40 rows (got ${rows.length})`);
  assert(rows.every((r) => r.attributes.cable_dest.length >= 1), 'run-joined CABLE DEST 1 column still maps cable destinations');
}

console.log('Edge cases:');
{
  assert(parseSchedule([], { present: false }).length === 0, 'present:false -> [] (VA / no schedule)');
  const { items } = qtsScheduleItems();
  const noTitle = parseSchedule(items, { ...cfg, locator: "table titled 'NONEXISTENT'" });
  assert(noTitle.length === 0, 'locator title not found -> [] (graceful, no throw)');
}

console.log(failures === 0 ? '\nALL GATES PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
