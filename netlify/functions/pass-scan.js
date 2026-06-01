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

// Extract TR room name from demarcation description or note text
// e.g. "Telecommunications Room BT03 on Level 00B serving data outlets"
// e.g. "DATA OUTLETS SHALL BE SERVED FROM TELECOMMUNICATIONS ROOM SL06"
function extractTRName(passBResult) {
  const candidates = [];

  // From demarcation label (most reliable)
  const demarc = passBResult?.demarcation;
  if (demarc?.found && demarc?.label) {
    candidates.push(demarc.label.trim());
  }

  // From demarcation description (natural language)
  const desc = demarc?.description ?? '';
  const descMatch = desc.match(/\b([A-Z]{1,4}[\d]{2,4}[A-Z]?)\b/g);
  if (descMatch) candidates.push(...descMatch);

  // From warnings / notes (Pass B sometimes puts TR ref in warnings)
  const warnings = passBResult?.warnings ?? [];
  for (const w of warnings) {
    const wMatch = w.match(/\b([A-Z]{1,4}[\d]{2,4}[A-Z]?)\b/g);
    if (wMatch) candidates.push(...wMatch);
  }

  // Filter to likely TR name patterns: 2-6 chars + 2-4 digits optional suffix
  const trPattern = /^([A-Z]{1,4}\d{2,4}[A-Z]?)$/;
  const trNames = [...new Set(candidates)].filter(c => trPattern.test(c));

  return trNames[0] ?? null;  // Best guess — first match
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
  const pageRecords  = [];
  const trMap        = {};   // TR name → { pages[], onSheet: bool, demarc_xy }

  for (const { eval_page_num, page_b_result } of pages) {
    if (!page_b_result) continue;

    const { building, floor, area } = parseSheetTitle(
      page_b_result.sheet_title
    );
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
        pdf_page_number: eval_page_num,
        building,
        level: floor,          // pages table uses 'level' not 'floor'
        area,
        tr_name:          trName,
        status:           'ready',
        scale_pts_per_ft: scalePtsPerFt,
        scale_paper_in:   s?.paper_value ?? null,
        scale_real_ft:    s?.real_value  ?? null,
        scale_label:      scale?.display_label ?? (s ? `${s.paper_value}" = ${s.real_value}'` : null)
      }, { onConflict: "project_id,pdf_page_number" })
      .select("id, pdf_page_number, building, level, area, tr_name, scale_label, scale_paper_in, scale_real_ft, scale_pts_per_ft")
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

    // Build TR map
    if (trName) {
      if (!trMap[trName]) {
        trMap[trName] = {
          name:       trName,
          pages:      [],
          on_sheet:   false,
          demarc_x:   null,
          demarc_y:   null,
          building:   null,
          floor:      null,
          area:       null
        };
      }
      trMap[trName].pages.push({
        page_id:      pageRec.id,
        eval_page_num,
        building,
        floor,
        area
      });

      const d = page_b_result.demarcation;

      // ── HOST: TR room physically drawn here (is_host=true, new scans) ──
      // Once confirmed, nothing overwrites it.
      if (d?.found && d?.is_host === true && !trMap[trName].host_confirmed) {
        trMap[trName].host_confirmed  = true;
        trMap[trName].on_sheet        = true;
        trMap[trName].demarc_x        = d.x;
        trMap[trName].demarc_y        = d.y;
        trMap[trName].building        = building;
        trMap[trName].floor           = floor;
        trMap[trName].area            = area;
        trMap[trName].demarc_page_id  = pageRec.id;
        trMap[trName].demarc_page_num = eval_page_num;

      // ── FALLBACK: no confirmed host yet, but this page has coords ──
      // Handles legacy scans (no is_host field) and cases where Claude
      // didn't return is_host. First page with found=true AND x/y wins.
      // A later page with is_host=true can still promote itself above this.
      } else if (!trMap[trName].host_confirmed && d?.found && d?.x != null && d?.y != null) {
        trMap[trName].on_sheet        = true;   // critical — was missing before
        trMap[trName].demarc_x        = d.x;
        trMap[trName].demarc_y        = d.y;
        trMap[trName].building        = building;
        trMap[trName].floor           = floor;
        trMap[trName].area            = area;
        trMap[trName].demarc_page_id  = pageRec.id;
        trMap[trName].demarc_page_num = eval_page_num;
        // host_confirmed stays false — a real is_host page can still win

      // ── REFERENCE ONLY: TR mentioned in notes, no coords ──
      // Page is served by this TR but the room isn't drawn here.
      // Never overwrite an already-found host or fallback.
      }
      // (pages[] already pushed above — no action needed here)
    }
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

  // ── Summary ───────────────────────────────────────────────────
  const trList = Object.values(trMap).map(tr => ({
    ...tr,
    status: tr.on_sheet ? 'on_sheet' : 'off_sheet'
  }));

  const offSheet = trList.filter(t => !t.on_sheet);
  const onSheet  = trList.filter(t => t.on_sheet);

  const warnings = [];
  if (offSheet.length) {
    warnings.push(
      `${offSheet.length} TR room(s) not found on selected pages — pin placement required: ` +
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
    demarcs_created: demarcsCreated.length,
    warnings
  });
}

export const config = { path: "/api/pass-scan" };
