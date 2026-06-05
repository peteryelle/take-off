// netlify/functions/pass-scan.js
// Phase 2 — Demarc Scanner
// Runs Pass B logic on each selected page to extract:
//   sheet title, building, floor, area, TR name, scale, demarc location
// Returns a TR map: unique TR rooms + which pages reference them
//
// POST /api/pass-scan
// Body: {
//   project_id,
//   pages: [{ eval_page_num, page_b_result }]
//   -- page_b_result is the Pass B JSON already run client-side
// }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

// Parse building/floor/area from sheet title
// e.g. "BLDG 01 - LEVEL 00B - AREA A - TELECOMMUNICATIONS PLAN"
function parseSheetTitle(title) {
  if (!title) return {};
  const t = title.toUpperCase();

  const bldgMatch  = t.match(/BLDG\s+([\w\d]+)/);
  const levelMatch = t.match(/LEVEL\s+([\w\d.]+)/);
  const areaMatch  = t.match(/AREA\s+([\w\d.]+)/);

  return {
    building: bldgMatch  ? `BLDG ${bldgMatch[1]}`  : null,
    floor:    levelMatch ? `LEVEL ${levelMatch[1]}` : null,
    area:     areaMatch  ? `AREA ${areaMatch[1]}`   : null,
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, pages } = body;
  if (!project_id || !pages?.length)
    return err("project_id and pages array required");

  const supabase = getSupabase();

  // ── 1. Persist each page (title, scale, building/floor/area) ──────────
  // TR identity is no longer derived from plan labels — it comes from the
  // schedule (v_page_tr_contract). Pages without a schedule contribute no
  // auto TRs; the user assigns them manually downstream.
  const pageRecords = [];
  const pageMeta    = {};   // page_id -> { eval_page_num, building, floor, area }

  for (const { eval_page_num, page_b_result } of pages) {
    if (!page_b_result) continue;

    const { building, floor, area } = parseSheetTitle(page_b_result.sheet_title);
    const scale = page_b_result.scale;

    let scalePtsPerFt = null;
    const s = scale?.text ?? scale?.graphic;
    if (s?.paper_value && s?.real_value && s?.paper_unit === 'in') {
      scalePtsPerFt = (72 * s.paper_value) / s.real_value;
    }

    const { data: pageRec, error: pgErr } = await supabase
      .from("pages")
      .upsert({
        project_id,
        pdf_page_number: eval_page_num,
        building,
        level: floor,          // pages table uses 'level' not 'floor'
        area,
        status:           'ready',
        scale_pts_per_ft: scalePtsPerFt,
        scale_paper_in:   s?.paper_value ?? null,
        scale_real_ft:    s?.real_value  ?? null,
        scale_label:      scale?.display_label ?? (s ? `${s.paper_value}" = ${s.real_value}'` : null)
      }, { onConflict: "project_id,pdf_page_number" })
      .select("id, pdf_page_number, building, level, area, scale_label, scale_paper_in, scale_real_ft, scale_pts_per_ft")
      .single();

    if (pgErr) {
      console.error(`Page ${eval_page_num} upsert error:`, pgErr.message);
      continue;
    }

    await supabase.from("project_pages").upsert({
      project_id,
      page_id:       pageRec.id,
      eval_page_num: eval_page_num,
      sort_order:    eval_page_num,
      selected:      true
    }, { onConflict: "project_id,eval_page_num" });

    pageRecords.push(pageRec);
    pageMeta[pageRec.id] = { eval_page_num, building, floor, area };
  }

  // ── 2. Seed the TR map from the schedule contract ─────────────────────
  // v_page_tr_contract yields, per page, each distinct cable destination (TR
  // room) with its run count, demarc, schematic (page_regions) and pin state.
  // A TR keys by name and accumulates the pages whose schedule references it.
  const trMap   = {};
  const pageIds = pageRecords.map(p => p.id);
  if (pageIds.length) {
    const { data: contract, error: cErr } = await supabase
      .from("v_page_tr_contract")
      .select("page_id, tr_room, runs, demarc_id, pin_x, pin_y, stub_ft, schematic_id, schematic, pinned, is_primary, status")
      .in("page_id", pageIds);
    if (cErr) console.error("v_page_tr_contract query error:", cErr.message);

    for (const row of (contract ?? [])) {
      const name = row.tr_room;
      const meta = pageMeta[row.page_id] ?? {};
      const onThisPage = row.status === 'on this page';

      const tr = trMap[name] ?? (trMap[name] = {
        name,
        pages:           [],
        runs:            0,
        on_sheet:        false,
        region_id:       null,
        schematic_id:    null,
        schematic:       null,
        is_primary:      false,
        demarc_id:       null,
        pinned:          false,
        demarc_x:        null,
        demarc_y:        null,
        pin_x:           null,
        pin_y:           null,
        stub_ft:         0,
        building:        null,
        floor:           null,
        area:            null,
        demarc_page_id:  null,
        demarc_page_num: null,
        status:          row.status
      });

      if (!tr.pages.find(p => p.page_id === row.page_id)) {
        tr.pages.push({ page_id: row.page_id, eval_page_num: meta.eval_page_num,
                        building: meta.building, floor: meta.floor, area: meta.area });
      }
      tr.runs        += row.runs ?? 0;
      tr.demarc_id    = tr.demarc_id    ?? row.demarc_id    ?? null;
      tr.region_id    = tr.region_id    ?? row.schematic_id ?? null;
      tr.schematic_id = tr.schematic_id ?? row.schematic_id ?? null;
      tr.schematic    = tr.schematic    ?? row.schematic    ?? null;
      tr.is_primary   = tr.is_primary   || !!row.is_primary;
      tr.pinned       = tr.pinned       || !!row.pinned;
      if (row.pin_x != null) { tr.pin_x = row.pin_x; tr.demarc_x = row.pin_x; }
      if (row.pin_y != null) { tr.pin_y = row.pin_y; tr.demarc_y = row.pin_y; }
      if (row.stub_ft != null) tr.stub_ft = row.stub_ft;

      // The TR's home page is the sheet carrying its schematic.
      if (onThisPage) {
        tr.on_sheet        = true;
        tr.status          = 'on this page';
        tr.demarc_page_id  = row.page_id;
        tr.demarc_page_num = meta.eval_page_num;
        tr.building        = meta.building;
        tr.floor           = meta.floor;
        tr.area            = meta.area;
      } else if (tr.status !== 'on this page') {
        tr.status = row.status;   // keep the most-resolved status
      }
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────────
  const trList   = Object.values(trMap);
  const onSheet  = trList.filter(t => t.on_sheet);
  const offSheet = trList.filter(t => !t.on_sheet);

  const warnings = [];
  const noDemarc = trList.filter(t => !t.demarc_id);
  if (noDemarc.length) {
    warnings.push(
      `${noDemarc.length} TR room(s) have no demarc yet — add + pin required: ` +
      noDemarc.map(t => t.name).join(', ')
    );
  }
  if (offSheet.length) {
    warnings.push(
      `${offSheet.length} TR room(s) not on a scanned schematic — pin on home page: ` +
      offSheet.map(t => t.name).join(', ')
    );
  }

  return ok({
    pass:          "scan",
    project_id,
    pages_scanned: pageRecords.length,
    tr_rooms:      trList.length,
    on_sheet:      onSheet.length,
    off_sheet:     offSheet.length,
    tr_map:        trList,
    warnings
  });
}

export const config = { path: "/api/pass-scan" };
