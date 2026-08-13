// netlify/functions/set-page-role.js
// POST /api/set-page-role
//   Body: { page_id, page_role?, tr_name?, tr_name_secondary? }        (legacy: update by row id)
//      or { project_id, pdf_page_number, page_role?, tr_name?, tr_name_secondary? }  (preferred: resolve/create)
//
// Persists per-page human assignments: page_role (plan|schedule|legend|detail|skip,
// or null/'' to clear back to needs-role), and/or tr_name / tr_name_secondary (the
// TR(s) this page hosts or is served by — null/'' clears). Only the fields present
// in the body are written; omitted fields are left untouched. This matters: a
// tr_name-only call must NOT clobber an already-set page_role, and vice versa —
// each field is independently optional, not a full-row overwrite.
//
// tr_name is the source of truth restoreFromSupabase() reads to reconstruct
// trMap[name].pages beyond a TR's own host page. Previously written only to the
// demarcs table (pin coordinates), never back to pages — so served-page
// assignments beyond a TR's host page were lost on every reload. tr_name_secondary
// covers the split-sheet case (a page's drawing references two TR names); it's
// persisted directly rather than re-derived from passBResult.description, which
// is not restored.
//
// Keying by (project_id, pdf_page_number) makes any of these fields saveable for
// ANY page the moment a human assigns it — no dependency on a prior scan or
// client cache. If the page row doesn't exist yet it is created (and linked in
// project_pages so a later restore sees it). A page declared non-counting carries
// no device count, so its device_instances are cleared — stale counts can't
// linger in the total.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
const ROLES        = new Set(["plan", "schedule", "legend", "detail", "skip"]);
const NON_COUNTING = new Set(["legend", "schedule", "detail", "skip"]);

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  let { page_id, project_id, pdf_page_number } = body;

  // Each of these three fields is independently optional: "present in body" (even
  // as null/'' to clear) vs "absent" are different things. Absent means leave the
  // column untouched — this is what stops a tr_name-only call from nulling out an
  // already-set page_role, and vice versa.
  const hasRole   = Object.prototype.hasOwnProperty.call(body, "page_role");
  const hasTr     = Object.prototype.hasOwnProperty.call(body, "tr_name");
  const hasTrSec  = Object.prototype.hasOwnProperty.call(body, "tr_name_secondary");
  if (!hasRole && !hasTr && !hasTrSec)
    return err("at least one of page_role, tr_name, tr_name_secondary required");

  const role = hasRole
    ? ((body.page_role === null || body.page_role === "") ? null : String(body.page_role))
    : undefined;
  if (hasRole && role !== null && !ROLES.has(role)) return err(`invalid page_role: ${role}`);

  const trName = hasTr
    ? ((body.tr_name === null || body.tr_name === "") ? null : String(body.tr_name).trim())
    : undefined;
  const trNameSecondary = hasTrSec
    ? ((body.tr_name_secondary === null || body.tr_name_secondary === "") ? null : String(body.tr_name_secondary).trim())
    : undefined;

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

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
      const insertRow = { project_id, pdf_page_number, status: "ready" };
      if (hasRole)  insertRow.page_role = role;
      if (hasTr)    insertRow.tr_name = trName;
      if (hasTrSec) insertRow.tr_name_secondary = trNameSecondary;
      const { data: ins, error: insErr } = await supabase
        .from("pages")
        .insert(insertRow)
        .select("id").single();
      if (insErr) return err(insErr.message);
      page_id = ins.id;
      // keep the project_pages link in sync so restore sees this page
      await supabase.from("project_pages")
        .upsert({ project_id, page_id, eval_page_num: pdf_page_number, sort_order: pdf_page_number },
                { onConflict: "project_id,eval_page_num" });
    }
  }

  const updates = {};
  if (hasRole)  updates.page_role = role;
  if (hasTr)    updates.tr_name = trName;
  if (hasTrSec) updates.tr_name_secondary = trNameSecondary;

  const { error: updErr } = await supabase
    .from("pages").update(updates).eq("id", page_id);
  if (updErr) return err(updErr.message);

  // Non-counting role -> page holds no device count. Only runs when page_role
  // was actually part of this call — a tr_name-only call must not touch counts.
  let cleared = 0;
  if (hasRole && role && NON_COUNTING.has(role)) {
    const { data: del } = await supabase
      .from("device_instances").delete().eq("page_id", page_id).select("id");
    cleared = del?.length ?? 0;
  }

  return ok({ page_id, page_role: role, tr_name: trName, tr_name_secondary: trNameSecondary, cleared });
}

export const config = { path: "/api/set-page-role" };
