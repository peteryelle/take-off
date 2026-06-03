// netlify/functions/set-page-role.js
// POST /api/set-page-role
//   Body: { page_id, page_role }                       (legacy: update by row id)
//      or { project_id, pdf_page_number, page_role }    (preferred: resolve/create)
//
// Persists the HUMAN-ASSIGNED page role (plan|schedule|legend|detail|skip, or
// null/'' to clear back to needs-role). Source of truth for the page-role gate.
//
// Keying by (project_id, pdf_page_number) makes a role saveable for ANY page the
// moment a human assigns it — no dependency on a prior scan or client cache. If
// the page row doesn't exist yet it is created (and linked in project_pages so a
// later restore sees it). A page declared non-counting carries no device count,
// so its device_instances are cleared — stale counts can't linger in the total.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

const ROLES        = new Set(["plan", "schedule", "legend", "detail", "skip"]);
const NON_COUNTING = new Set(["legend", "schedule", "detail", "skip"]);

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  let { page_id, project_id, pdf_page_number } = body;
  const role = (body.page_role === null || body.page_role === "") ? null : String(body.page_role);
  if (role !== null && !ROLES.has(role)) return err(`invalid page_role: ${role}`);

  const supabase = getSupabase();

  // Resolve (or create) the page row.
  if (!page_id) {
    if (!project_id || !pdf_page_number)
      return err("page_id, or project_id + pdf_page_number, required");

    const { data: found, error: selErr } = await supabase
      .from("pages").select("id")
      .eq("project_id", project_id).eq("pdf_page_number", pdf_page_number)
      .maybeSingle();
    if (selErr) return err(selErr.message);

    if (found) {
      page_id = found.id;
    } else {
      const { data: ins, error: insErr } = await supabase
        .from("pages")
        .insert({ project_id, pdf_page_number, page_role: role, status: "ready" })
        .select("id").single();
      if (insErr) return err(insErr.message);
      page_id = ins.id;
      // keep the project_pages link in sync so restore sees this page
      await supabase.from("project_pages")
        .upsert({ project_id, page_id, eval_page_num: pdf_page_number, sort_order: pdf_page_number },
                { onConflict: "project_id,eval_page_num" });
    }
  }

  const { error: updErr } = await supabase
    .from("pages").update({ page_role: role }).eq("id", page_id);
  if (updErr) return err(updErr.message);

  // Non-counting role -> page holds no device count.
  let cleared = 0;
  if (role && NON_COUNTING.has(role)) {
    const { data: del } = await supabase
      .from("device_instances").delete().eq("page_id", page_id).select("id");
    cleared = del?.length ?? 0;
  }

  return ok({ page_id, page_role: role, cleared });
}
