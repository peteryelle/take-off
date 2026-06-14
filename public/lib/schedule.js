// schedule.js — pure schedule-table parser for the v2 contract.
// No PDF, no DOM, no network. Imported by both pipelines and the server.
//
// Reads the sheet-level schedule block (pages.schedule):
//   { present, locator, columns: { uin, detail_sheet, cable_dest: [...] }, type_from }
// and the page text layer ([{ str, cx_norm, cy_norm }]), reconstructs the table,
// and emits schedule_rows in the shape reconcile() seeds from:
//   { uin, type, attributes: { cable_dest: [...], detail_sheet } }
//
// Table reconstruction is spatial: group items into rows by y, locate the header
// row from the configured column labels (run-joining split words), fix each
// column's x from its header, then assign every data cell to the nearest column.

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
const leadAlpha = (s) => (String(s).match(/^[A-Z]+/) || [''])[0];

// Pull the table title out of a locator like: table titled 'DETAIL SCHEDULE'
function titleFromLocator(locator) {
  if (!locator) return null;
  const q = String(locator).match(/['"]([^'"]+)['"]/);
  if (q) return norm(q[1]);
  return norm(String(locator).replace(/^\s*table\s+titled\s+/i, ''));
}

// Group items into visual rows by y proximity (items pre-sorted by y).
function groupRows(items, rowTol) {
  const sorted = [...items].sort((a, b) => a.cy_norm - b.cy_norm);
  const rows = [];
  let cur = [];
  let lastY = null;
  for (const it of sorted) {
    if (lastY == null || Math.abs(it.cy_norm - lastY) <= rowTol) {
      cur.push(it);
    } else {
      rows.push(cur); cur = [it];
    }
    lastY = it.cy_norm;
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.cx_norm - b.cx_norm));
}

// Find the x-centroid of a header label within a row, joining up to `maxRun`
// adjacent items (handles "CABLE DEST 1" split across items). null if absent.
function headerX(rowItems, label, maxRun = 4) {
  const target = norm(label);
  for (let i = 0; i < rowItems.length; i++) {
    let joined = '';
    for (let n = 0; n < maxRun && i + n < rowItems.length; n++) {
      joined = norm(joined + ' ' + rowItems[i + n].str);
      if (joined === target) {
        const run = rowItems.slice(i, i + n + 1);
        return run.reduce((s, it) => s + it.cx_norm, 0) / run.length;
      }
    }
  }
  return null;
}

/**
 * @param {Array}  textItems  [{ str, cx_norm, cy_norm }]
 * @param {Object} scheduleCfg  pages.schedule block
 * @param {Object} opts  { rowTol }
 * @returns {Array} schedule_rows
 */
export function parseSchedule(textItems = [], scheduleCfg = {}, opts = {}) {
  if (!scheduleCfg || scheduleCfg.present === false) return [];
  const cols = scheduleCfg.columns || {};
  if (!cols.uin) return [];
  const rowTol = opts.rowTol ?? 0.012;

  // Logical column descriptors (cable_dest may have several physical columns).
  const colDefs = [
    { key: 'uin', label: cols.uin },
    ...(cols.detail_sheet ? [{ key: 'detail_sheet', label: cols.detail_sheet }] : []),
    ...((Array.isArray(cols.cable_dest) ? cols.cable_dest : cols.cable_dest ? [cols.cable_dest] : [])
      .map((l) => ({ key: 'cable_dest', label: l, multi: true }))),
  ];

  // 1. Locate the table by its title; keep items below it.
  const title = titleFromLocator(scheduleCfg.locator);
  let region = textItems;
  if (title) {
    const rowsAll = groupRows(textItems, rowTol);
    let titleY = null;
    for (const r of rowsAll) {
      const joined = norm(r.map((it) => it.str).join(' '));
      if (joined.includes(title)) { titleY = r[0].cy_norm; break; }
    }
    if (titleY == null) return [];                 // locator not found -> nothing to parse
    region = textItems.filter((it) => it.cy_norm > titleY + rowTol / 2);
  }

  // 2. Find the header row: the row that contains the uin column label.
  const rows = groupRows(region, rowTol);
  let headerIdx = -1, headerXs = null;
  for (let i = 0; i < rows.length; i++) {
    const xs = colDefs.map((c) => ({ ...c, x: headerX(rows[i], c.label) }));
    if (xs[0].x != null) { headerIdx = i; headerXs = xs.filter((c) => c.x != null); break; }
  }
  if (headerIdx < 0) return [];

  // 3. Parse data rows below the header — assign each cell to nearest column x.
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const acc = {};                                 // x -> joined text, keyed per header instance
    const accPos = {};                              // x -> [[cx,cy], ...] for the same cells
    headerXs.forEach((c, idx) => { acc[idx] = []; accPos[idx] = []; });
    for (const it of rows[i]) {
      let best = -1, bestD = Infinity;
      headerXs.forEach((c, idx) => {
        const d = Math.abs(it.cx_norm - c.x);
        if (d < bestD) { bestD = d; best = idx; }
      });
      if (best >= 0) { acc[best].push(it.str); accPos[best].push([it.cx_norm, it.cy_norm]); }
    }
    const cellOf = (idx) => norm(acc[idx].join(' ')).trim();

    let uin = null, detailSheet = null, uinIdx = -1;
    const cableDest = [];
    headerXs.forEach((c, idx) => {
      const v = cellOf(idx);
      if (c.key === 'uin') { uin = v; uinIdx = idx; }
      else if (c.key === 'detail_sheet') detailSheet = v || null;
      else if (c.key === 'cable_dest' && v && v !== '-') cableDest.push(v);
    });

    // UINs are single code tokens (CAM-EXT-1, SF1, N2). Reject footers/notes
    // like "TOTAL DEVICES: 40" — anything with spaces, colons, or a non-code start.
    if (!uin || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(uin)) continue;

    // UIN-cell centroid: the schedule's OWN text position. reconcile uses it to tell
    // a re-detected schedule label (echo) from a real plan stamp, so the device lands
    // on the plan, not parked on the table. null when the cell had no positioned item.
    let x = null, y = null;
    const pos = uinIdx >= 0 ? accPos[uinIdx] : [];
    if (pos.length) {
      x = pos.reduce((s, p) => s + p[0], 0) / pos.length;
      y = pos.reduce((s, p) => s + p[1], 0) / pos.length;
    }

    const type = scheduleCfg.type_from === 'uin_prefix' ? leadAlpha(uin) : (scheduleCfg.type || null);
    out.push({ uin, type, x, y, attributes: { cable_dest: cableDest, detail_sheet: detailSheet } });
  }

  return out;
}

export default parseSchedule;
