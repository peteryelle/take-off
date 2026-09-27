// public/lib/wf8-workbook.js
// Writes the BOM workbook from the WF8 model (public/lib/wf8-bom.js).
// Pass the ExcelJS module in (browser: window.ExcelJS from cdnjs; tests: npm exceljs).
//
// Layout follows the project's BOM workbook: same sheet names and columns, same
// pricing columns and arithmetic (sell = cost / (1 - margin); labor $ = min / 60 × rate;
// extended = qty × unit). Quantities are VALUES from confirmed app data — no take-off
// rule is written as a formula. Blank cost / margin / labor cells are for the user.
// ─────────────────────────────────────────────────────────────────────────────

const FONT = { name: 'Arial', size: 10 };
const HEAD = { font: { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F4F' } } };
const INPUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };   // cells the user fills in
const TOTAL_FONT = { name: 'Arial', size: 10, bold: true };
const MONEY = '$#,##0.00;($#,##0.00);-';
const PCT = '0.0%';
const col = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function sheet(wb, name, headers, widths = []) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const row = ws.addRow(headers);
  row.eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; c.alignment = { wrapText: true, vertical: 'bottom' }; });
  row.height = 30;
  headers.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 14; });
  return ws;
}
// Set a row cell by cell (formula objects set per cell survive every ExcelJS build).
function putRow(ws, r, values) {
  const row = ws.getRow(r);
  values.forEach((v, i) => { if (v !== undefined) row.getCell(i + 1).value = v; });
  return row;
}
function styleRow(row) { row.eachCell({ includeEmpty: true }, (c) => { if (!c.font || !c.font.bold) c.font = { ...FONT, ...(c.font || {}) }; }); }

// Pricing block: cost | margin | sell | labor min | rate | labor $/unit | material ext | labor ext | total ext.
// qtyCol and first pricing column are 1-based column numbers.
function pricing(ws, r, qtyCol, c0) {
  const Q = `${col(qtyCol)}${r}`, C = `${col(c0)}${r}`, M = `${col(c0 + 1)}${r}`, S = `${col(c0 + 2)}${r}`,
    L = `${col(c0 + 3)}${r}`, R = `${col(c0 + 4)}${r}`, LU = `${col(c0 + 5)}${r}`, ME = `${col(c0 + 6)}${r}`, LE = `${col(c0 + 7)}${r}`;
  const set = (c, v, fmt) => { const cell = ws.getCell(`${col(c)}${r}`); cell.value = v; if (fmt) cell.numFmt = fmt; cell.font = FONT; return cell; };
  for (const k of [0, 1, 3, 4]) { const cell = ws.getCell(`${col(c0 + k)}${r}`); cell.fill = INPUT_FILL; cell.font = FONT; }
  ws.getCell(C).numFmt = MONEY; ws.getCell(M).numFmt = PCT; ws.getCell(R).numFmt = MONEY;
  set(c0 + 2, { formula: `IFERROR(IF(OR(${C}="",${M}=""),"",${C}/(1-${M})),"")` }, MONEY);
  set(c0 + 5, { formula: `IFERROR(IF(OR(${L}="",${R}=""),"",(${L}/60)*${R}),"")` }, MONEY);
  set(c0 + 6, { formula: `IFERROR(${Q}*${S},"")` }, MONEY);
  set(c0 + 7, { formula: `IFERROR(${Q}*${LU},"")` }, MONEY);
  set(c0 + 8, { formula: `IFERROR(${ME}+${LE},"")` }, MONEY);
}
const PRICE_HEADS = ['Unit Cost ($)', 'Margin (%)', 'Sell Price / Unit ($)', 'Labor Time (min/install)', 'Unit Labor Rate ($/hr)', 'Labor $ / Unit',
  'Material $ Extended', 'Labor $ Extended', 'Total $ Extended'];
function grandTotal(ws, r, fromRow, toRow, c0, label = 'GRAND TOTAL') {
  const row = ws.getRow(r);
  row.getCell(1).value = label;
  for (const k of [6, 7, 8]) {
    const c = col(c0 + k);
    row.getCell(c0 + k).value = toRow >= fromRow ? { formula: `SUM(${c}${fromRow}:${c}${toRow})` } : 0;
    row.getCell(c0 + k).numFmt = MONEY;
  }
  row.eachCell({ includeEmpty: false }, (c) => { c.font = TOTAL_FONT; });
}

export function buildWorkbook(ExcelJS, model, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Take-off'; wb.created = meta.generated_at ? new Date(meta.generated_at) : new Date();
  const S = model.sheets;

  // ── TR Schedule ──
  {
    const ws = sheet(wb, 'TR Schedule', ['Building', 'Level', 'TR Number', 'Total Cat6A Terminations', 'Min Patch Panels', 'New Racks (WF5)', 'Existing Racks (WF5)',
      'Wall-mount (WF5)', 'ISP / OSP (WF7)', 'Status', 'Manual Override'], [12, 10, 14, 14, 12, 11, 11, 11, 11, 10, 60]);
    for (const t of S.tr_schedule) {
      styleRow(ws.addRow([t.building, t.level, t.tr, t.terminations, t.panels, t.racks_new, t.racks_existing,
        t.wall_mount == null ? null : t.wall_mount ? 'yes' : 'no', t.isp_osp ? t.isp_osp.toUpperCase() : null, t.status || null,
        t.source === 'extracted' ? null : `${t.source === 'manual' ? 'Entered by hand' : 'Edited'}: ${t.basis || ''}`]));
    }
  }

  // ── Rack BOM ──
  {
    const cols = S.rack_bom.columns;
    const ws = sheet(wb, 'Rack BOM', ['TR', 'Rack #', 'Rack ID', ...cols.map((c) => (c.zone ? `${c.zone[0].toUpperCase()}${c.zone.slice(1)}: ` : '') + c.label), 'Notes'],
      [14, 8, 18, ...cols.map(() => 16), 50]);
    for (const r of S.rack_bom.rows) styleRow(ws.addRow([r.tr, r.rack_no, r.rack_id, ...cols.map((c) => r.cells[c.rule_key]), null]));
    const n = S.rack_bom.rows.length;
    if (n) {
      const tr = putRow(ws, n + 2, ['TOTAL', null, { formula: `COUNTA(C2:C${n + 1})` }, ...cols.map((_, i) => ({ formula: `SUM(${col(4 + i)}2:${col(4 + i)}${n + 1})` }))]);
      tr.eachCell((c) => { c.font = TOTAL_FONT; });
    }
  }

  // ── TR Summary ──
  {
    const cols = S.tr_summary.columns;
    const ws = sheet(wb, 'TR Summary', ['TR', 'New Racks', ...cols.map((c) => c.label), 'Check', 'Notes'], [14, 10, ...cols.map(() => 16), 30, 60]);
    for (const r of S.tr_summary.rows) styleRow(ws.addRow([r.tr, r.racks, ...cols.map((c) => r.cells[c.rule_key]), r.check?.text || null, r.open.join(' · ') || null]));
    const n = S.tr_summary.rows.length;
    if (n) {
      const tr = putRow(ws, n + 2, ['TOTAL', { formula: `SUM(B2:B${n + 1})` }, ...cols.map((_, i) => ({ formula: `SUM(${col(3 + i)}2:${col(3 + i)}${n + 1})` }))]);
      tr.eachCell((c) => { c.font = TOTAL_FONT; });
    }
  }

  // ── Summary (rack hardware + pricing) ──
  {
    const ws = sheet(wb, 'Summary', ['Item Description', 'Detail', 'Basis of Design / Manufacturer', 'Total Qty', 'Formula / Source', ...PRICE_HEADS, 'Retail Price Source / Note'],
      [40, 34, 30, 10, 34, 11, 9, 12, 12, 12, 11, 14, 14, 14, 40]);
    let r = 2;
    for (const it of S.summary) {
      putRow(ws, r, [it.item, it.detail, it.install_only ? 'Install only (owner furnished)' : it.part, it.qty,
        `WF6 · ${it.ref || ''} confirmed rule${it.missing ? ` · ${it.missing} TR(s) not counted yet` : ''}`]);
      styleRow(ws.getRow(r)); pricing(ws, r, 4, 6); r++;
    }
    grandTotal(ws, r, 2, r - 1, 6);
  }

  // ── Device Counts / Lengths, by Device ──
  const levelGrid = (name, grid, key, unitWord) => {
    const types = grid.types;
    const ws = sheet(wb, name, ['Level', ...types, 'Total', 'Material $ Total', 'Labor $ Total', 'Total $'], [14, ...types.map(() => 14), 12, 16, 16, 16]);
    const nT = types.length, tCol = nT + 2;
    const first = 2, last = first + grid.rows.length - 1;
    grid.rows.forEach((row, i) => {
      const r = first + i;
      putRow(ws, r, [row.level, ...types.map((t) => row[key][t] ?? 0)]);
      styleRow(ws.getRow(r));
    });
    const totalRow = last + 1;
    const priceRow0 = totalRow + 2;   // Unit cost, margin, sell, labor min, rate, labor $/unit
    const labels = [`Unit Cost ($ per ${unitWord})`, 'Margin (%)', `Sell Price / ${unitWord} ($)`, `Labor Time (min per ${unitWord})`, 'Unit Labor Rate ($/hr)', `Labor $ / ${unitWord}`];
    labels.forEach((l, k) => { const c = ws.getCell(priceRow0 + k, 1); c.value = l; c.font = TOTAL_FONT; });
    const range = (r) => `B${r}:${col(nT + 1)}${r}`;
    for (let i = 0; i < nT; i++) {
      const c = col(i + 2);
      ws.getCell(`${c}${totalRow}`).value = grid.rows.length ? { formula: `SUM(${c}${first}:${c}${last})` } : 0;
      for (const k of [0, 1, 3, 4]) ws.getCell(`${c}${priceRow0 + k}`).fill = INPUT_FILL;
      ws.getCell(`${c}${priceRow0}`).numFmt = MONEY; ws.getCell(`${c}${priceRow0 + 1}`).numFmt = PCT; ws.getCell(`${c}${priceRow0 + 4}`).numFmt = MONEY;
      ws.getCell(`${c}${priceRow0 + 2}`).value = { formula: `IFERROR(IF(OR(${c}${priceRow0}="",${c}${priceRow0 + 1}=""),"",${c}${priceRow0}/(1-${c}${priceRow0 + 1})),"")` };
      ws.getCell(`${c}${priceRow0 + 2}`).numFmt = MONEY;
      ws.getCell(`${c}${priceRow0 + 5}`).value = { formula: `IFERROR(IF(OR(${c}${priceRow0 + 3}="",${c}${priceRow0 + 4}=""),"",(${c}${priceRow0 + 3}/60)*${c}${priceRow0 + 4}),"")` };
      ws.getCell(`${c}${priceRow0 + 5}`).numFmt = MONEY;
    }
    for (let r = first; r <= totalRow; r++) {
      if (r > last && r !== totalRow) continue;
      ws.getCell(r, tCol).value = nT ? { formula: `SUM(${range(r)})` } : 0;
      ws.getCell(r, tCol + 1).value = { formula: `IFERROR(SUMPRODUCT(${range(r)},${range(priceRow0 + 2)}),"")` };
      ws.getCell(r, tCol + 2).value = { formula: `IFERROR(SUMPRODUCT(${range(r)},${range(priceRow0 + 5)}),"")` };
      ws.getCell(r, tCol + 3).value = { formula: `IFERROR(${col(tCol + 1)}${r}+${col(tCol + 2)}${r},"")` };
      for (const k of [1, 2, 3]) ws.getCell(r, tCol + k).numFmt = MONEY;
    }
    const tr = ws.getRow(totalRow); tr.getCell(1).value = 'TOTAL'; tr.eachCell((c) => { c.font = TOTAL_FONT; });
    return ws;
  };
  levelGrid('Device Counts', S.device_counts, 'counts', 'unit');
  levelGrid('Lengths, by Device', S.lengths, 'ft', 'ft');

  // ── Floor Assemblies ──
  {
    const ws = sheet(wb, 'Floor Assemblies', ['Outlet Type', 'Ports per Outlet', 'Faceplate Qty', 'Jack Qty', 'Pigtail Qty', ...PRICE_HEADS, 'Notes'],
      [22, 10, 11, 10, 10, 11, 9, 12, 12, 12, 11, 14, 14, 14, 44]);
    let r = 2;
    for (const f of S.floor_assemblies) {
      putRow(ws, r, [f.type, f.ports, f.faceplates, f.jacks, null]);
      ws.getCell(r, 15).value = f.ports == null ? 'Ports per outlet not set in the device library — jacks left blank.' : 'Faceplates = outlets counted (WF4); jacks = outlets × ports per outlet.';
      styleRow(ws.getRow(r)); pricing(ws, r, 4, 6); r++;
    }
    grandTotal(ws, r, 2, r - 1, 6, 'TOTAL');
  }

  // ── Ancillary Components ──
  {
    const ws = sheet(wb, 'Ancillary Components', ['Component', 'Basis / Formula', 'Qty', ...PRICE_HEADS, 'Notes'], [34, 40, 10, 11, 9, 12, 12, 12, 11, 14, 14, 14, 40]);
    let r = 2;
    for (const a of S.ancillary) {
      putRow(ws, r, [a.item + (a.unit === 'ft' ? ' (ft)' : ''), `Sum of TR room values (WF5) across ${a.trs} TR(s)`, a.qty]);
      if (a.category === 'rack_existing') ws.getCell(r, 13).value = 'Existing racks remain — reference only, not priced.';
      styleRow(ws.getRow(r)); if (a.category !== 'rack_existing') pricing(ws, r, 3, 4); r++;
    }
    grandTotal(ws, r, 2, r - 1, 4, 'TOTAL');
  }

  // ── Backbone (new) ──
  {
    const ws = sheet(wb, 'Backbone', ['TR', 'Building', 'Floor', 'On the riser', 'Core cable notes', 'Cores', 'ISP / OSP', 'Strands per core', 'Added from riser'],
      [14, 18, 16, 18, 16, 8, 10, 18, 12]);
    for (const b of S.backbone.rows) styleRow(ws.addRow([b.tr, b.building, b.floor, b.riser_label, b.notes, b.cores, b.isp_osp ? b.isp_osp.toUpperCase() : null, b.strands_text, b.added ? 'yes' : null]));
    const start = S.backbone.rows.length + 3;
    const h = ws.getRow(start);
    putRow(ws, start, ['Cable (coded note)', 'Strands per core', 'ISP / OSP', 'Core runs', ...PRICE_HEADS]);
    h.eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; });
    let r = start + 1;
    for (const t of S.backbone.totals) {
      putRow(ws, r, [`CN ${t.note_number}: ${t.cable}`, t.strands_text, t.isp_osp ? t.isp_osp.toUpperCase() : null, t.cores]);
      styleRow(ws.getRow(r)); pricing(ws, r, 4, 5); r++;
    }
    grandTotal(ws, r, start + 1, r - 1, 5, 'TOTAL');
    ws.getCell(r + 2, 1).value = 'Core runs = cores fed by each cable on the confirmed riser. Price per run, or replace with footage when routes are measured.';
    ws.getCell(r + 2, 1).font = { ...FONT, italic: true };
  }

  // ── Allowances (new) ──
  {
    const ws = sheet(wb, 'Allowances', ['System', 'Item (as read)', 'Per Unit', 'Unit', 'Unit Count', 'Total Qty', ...PRICE_HEADS, 'Source'], [26, 60, 9, 7, 9, 10, 11, 9, 12, 12, 12, 11, 14, 14, 14, 30]);
    let r = 2;
    for (const a of S.allowances) {
      putRow(ws, r, [a.system, a.item, a.per_unit_qty, a.unit, a.unit_count, { formula: `IFERROR(C${r}*E${r},"")` }]);
      ws.getCell(r, 16).value = a.note_ref || null;
      styleRow(ws.getRow(r)); pricing(ws, r, 6, 7); r++;
    }
    grandTotal(ws, r, 2, r - 1, 7, 'TOTAL');
  }

  // ── Notes & Assumptions ──
  {
    const ws = sheet(wb, 'Notes & Assumptions', ['Topic', 'Note'], [40, 120]);
    ws.addRow(['Generated', `${meta.generated_at || new Date().toISOString()}${meta.label ? ' · ' + meta.label : ''}${meta.project ? ' · ' + meta.project : ''}`]);
    for (const n of S.notes) { const row = ws.addRow([n.topic, n.text]); row.getCell(2).alignment = { wrapText: true }; }
    ws.eachRow((row) => styleRow(row));
  }
  return wb;
}

// Change-order workbook: lines with ref / current / delta, and the same pricing columns.
export function buildCoWorkbook(ExcelJS, co, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Take-off';
  const ws = sheet(wb, 'Change Order', ['Line', 'Item', 'Unit', 'Reference Qty', 'Current Qty', 'Delta', ...PRICE_HEADS, 'Cause'], [9, 50, 7, 12, 12, 10, 11, 9, 12, 12, 12, 11, 14, 14, 14, 60]);
  let r = 2;
  for (const l of co.lines) {
    putRow(ws, r, [l.line_type, l.item, l.unit, l.ref_qty, l.cur_qty, { formula: `E${r}-D${r}` }]);
    ws.getCell(r, 16).value = l.cause_note || null;
    styleRow(ws.getRow(r)); pricing(ws, r, 6, 7); r++;
  }
  grandTotal(ws, r, 2, r - 1, 7, 'NET');
  ws.getCell(r + 2, 1).value = `${co.number || 'Change order'} · against ${meta.reference || 'the reference'} · generated ${meta.generated_at || new Date().toISOString()}`;
  ws.getCell(r + 2, 1).font = { ...FONT, italic: true };
  return wb;
}
