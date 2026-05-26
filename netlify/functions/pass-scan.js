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

// Extract TR room name from demarcation label, description, or warnings.
// Returns the best single candidate, or null.
function extractTRName(passBResult) {
  const candidates = [];

  // From demarcation label (most reliable — Claude extracts this directly)
  const demarc = passBResult?.demarcation;
  if (demarc?.found && demarc?.label) {
    candidates.push(demarc.label.trim());
  }

  // From demarcation description (natural language fallback)
  const desc = demarc?.description ?? '';
  const descMatch = desc.match(/\b([A-Z]{1,4}[\d]{2,4}[A-Z]?)\b/g);
  if (descMatch) candidates.push(...descMatch);

  // From warnings / notes (Pass B sometimes puts TR ref in warnings)
  const warnings = passBResult?.warnings ?? [];
  for (const w of warnings) {
    const wMatch = w.match(/\b([A-Z]{1,4}[\d]{2,4}[A-Z]?)\b/g);
    if (wMatch) candidates.push(...wMatch);
  }

  // Filter to likely TR name patterns: 2-6 alpha chars + 2-4 digits + optional suffix
  const trPattern = /^([A-Z]{1,4}\d{2,4}[A-Z]?)$/;
  const trNames = [...new Set(candidates)].filter(c => trPattern.test(c));

  return trNames[0] ?? null;
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

  // ── Process each page result ──────────────────────────────────
  const pageRecords = [];
  const trMap       = {};   // TR name → aggregated TR record

  for (const { eval_page_num, page_b_result } of pages) {
    if (!page_b_result) continue;

    const { building, floor, area } = parseSheetTitle(page_b_result.sheet_title);
    const trName = extractTRName(page_b_result);
    const scale  = page_b_result.scale;

    // Calc pts_per_ft from scale
    let scalePtsPerFt = null;
    const s = scale?.text ?? scale?.graphic;
    if (s?.paper_value && s?.real_value && s?.paper_unit === 'in') {
      scalePtsPerFt = (72 * s.paper_value) / s.real_value;
    }

    // Upsert page record
    const { data: pageRec, error: pgErr } = await supabase
      .from("pages")
      .upsert({
        project_id,
        pdf_page_number:  eval_page_num,
        building,
        level:            floor,   // pages table uses 'level' not 'floor'
        area,
        tr_name:          trName,
        status:           'ready',
        scale_pts_per_ft: scalePtsPerFt,
        scale_paper_in:   s?.paper_value ?? null,
        scale_real_ft:    s?.real_value  ?? null
      }, { onConflict: "project_id,pdf_page_number" })
      .select("id, pdf_page_number, building, level, area, tr_name")
      .single();

    if (pgErr) {
      console.error(`Page ${eval_page_num} upsert error:`, pgErr.message);
      continue;
    }

    // Upsert project_pages entry
    await supabase.from("project_pages").upsert({
      project_id,
      page_id:       pageRec.id,
      eval_page_num: eval_page_num,
      sort_order:    eval_page_num,
      selected:      true
    }, { onConflict: "project_id,eval_page_num" });

    pageRecords.push(pageRec);

    // ── Build TR map entry for this page ──────────────────────────
    if (!trName) continue;

    if (!trMap[trName]) {
      trMap[trName] = {
        name:              trName,
        pages:             [],
        host_confirmed:    false,   // true once a page with is_host=true is found
        on_sheet:          false,
        demarc_page_id:    null,
        demarc_page_num:   null,
        demarc_x:          null,
        demarc_y:          null,
        // Location fields come from the HOST page, not from served pages
        building:          null,
        floor:             null,
        area:              null,
      };
    }

    // Always add this page to the list of pages served by this TR
    trMap[trName].pages.push({
      page_id:      pageRec.id,
      eval_page_num,
      building,
      floor,
      area
    });

    const d = page_b_result.demarcation;

    // ── HOST PAGE: TR room is physically drawn here ───────────────
    // Only set demarc location from a host page. Once confirmed, never
    // overwrite with a served-page reference (is_host=false).
    if (d?.found && d?.is_host === true && !trMap[trName].host_confirmed) {
      trMap[trName].host_confirmed  = true;
      trMap[trName].on_sheet        = true;
      trMap[trName].demarc_page_id  = pageRec.id;
      trMap[trName].demarc_page_num = eval_page_num;
      trMap[trName].demarc_x        = d.x;
      trMap[trName].demarc_y        = d.y;
      // TR room location metadata comes from the host page
      trMap[trName].building        = building;
      trMap[trName].floor           = floor;
      trMap[trName].area            = area;
    }

    // ── SERVED PAGE: TR referenced in notes only (is_host=false) ─
    // We still have the TR name (already pushed to pages[]) so distance
    // measurement knows which demarc to use. But we do NOT update
    // demarc_page_num, demarc_x/y, or location — those belong to the host.
  }

  // ── Upsert demarc records for on-sheet TRs ────────────────────
  const demarcsCreated = [];
  for (const tr of Object.values(trMap)) {
    if (!tr.on_sheet) continue;   // off-sheet → user sets pin manually

    const { data: demarcRec, error: dmErr } = await supabase
      .from("demarcs")
      .upsert({
        project_id,
        page_id:  tr.demarc_page_id,
        name:     tr.name,
        source:   'auto',
        x_norm:   tr.demarc_x,
        y_norm:   tr.demarc_y,
        stub_ft:  0,
        building: tr.building,
        floor:    tr.floor,
        area:     tr.area
      }, { onConflict: "project_id,name" })
      .select("id, name, x_norm, y_norm")
      .single();

    if (!dmErr) demarcsCreated.push(demarcRec);
  }

  // ── Build summary list ─────────────────────────────────────────
  const trList = Object.values(trMap).map(tr => ({
    name:            tr.name,
    building:        tr.building,
    floor:           tr.floor,
    area:            tr.area,
    demarc_page_num: tr.demarc_page_num,
    demarc_x:        tr.demarc_x,
    demarc_y:        tr.demarc_y,
    pages:           tr.pages,
    host_confirmed:  tr.host_confirmed,
    status:          tr.on_sheet ? 'on_sheet' : 'off_sheet'
  }));

  const offSheet = trList.filter(t => t.status === 'off_sheet');
  const onSheet  = trList.filter(t => t.status === 'on_sheet');

  const warnings = [];
  if (offSheet.length) {
    warnings.push(
      `${offSheet.length} TR room(s) not found on selected pages — pin placement required: ` +
      offSheet.map(t => t.name).join(', ')
    );
  }

  return ok({
    pass:            "scan",
    project_id,
    pages_scanned:   pageRecords.length,
    tr_rooms:        trList.length,
    on_sheet:        onSheet.length,
    off_sheet:       offSheet.length,
    tr_map:          trList,
    demarcs_created: demarcsCreated.length,
    warnings
  });
}

export const config = { path: "/api/pass-scan" };
