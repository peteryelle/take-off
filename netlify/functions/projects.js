// netlify/functions/projects.js
// GET  /api/projects                     — list projects (caller's org only)
// POST /api/projects { name, ... }       — create a new project (stamped to caller's org)
// POST /api/projects { action: ... }     — device type / project management actions
// ─────────────────────────────────────────────────────────────────
// Tenant boundary: requireOrg() authenticates and resolves the caller's org;
// every project_id touched is checked against that org before any work.

import { ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg } from "./utils/auth.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list projects (org-scoped) ──────────────────────────
  if (req.method === "GET") {
    const { data: viewData, error: viewErr } = await supabase
      .from("v_project_list")
      .select("*")
      .eq("org_id", orgId);

    if (!viewErr && viewData) return ok(viewData);

    // Fallback: base table
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, project_number, client, pdf_filename, pdf_page_count, created_at, updated_at, last_run_at")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false });

    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST ──────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { action } = body;

    // ── Action: upsert device type ─────────────────────────────
    if (action === "upsert_device_type") {
      const {
        project_id, id,
        legend_id, name,
        human_description,
        example_image_base64
      } = body;

      if (!project_id || !legend_id || !name)
        return err("project_id, legend_id and name required");
      if (!(await assertProjectInOrg(supabase, project_id, orgId)))
        return err("Project not found in your organization", 404);

      const row = {
        project_id,
        legend_id,
        name,
        human_description:    human_description    ?? null,
        example_image_base64: example_image_base64 ?? null,
        updated_at:           new Date()
      };

      let result;
      if (id && id > 0) {
        const { data, error } = await supabase
          .from("device_types")
          .update(row)
          .eq("id", id)
          .eq("project_id", project_id)
          .select("id, legend_id, name")
          .single();
        if (error) return err(error.message, 500);
        result = data;
      } else {
        const { data, error } = await supabase
          .from("device_types")
          .insert(row)
          .select("id, legend_id, name")
          .single();
        if (error) return err(error.message, 500);
        result = data;
      }

      return ok(result, id ? 200 : 201);
    }

    // ── Action: delete device type ─────────────────────────────
    if (action === "delete_device_type") {
      const { project_id, id } = body;
      if (!project_id || !id) return err("project_id and id required");
      if (!(await assertProjectInOrg(supabase, project_id, orgId)))
        return err("Project not found in your organization", 404);

      const { error } = await supabase
        .from("device_types")
        .delete()
        .eq("id", id)
        .eq("project_id", project_id);

      if (error) return err(error.message, 500);
      return ok({ deleted: true, id });
    }

    // ── Action: copy device types between projects ──────────────
    if (action === "copy_device_types") {
      const { source_project_id, target_project_id } = body;
      if (!source_project_id || !target_project_id)
        return err("source_project_id and target_project_id required");
      // both ends must belong to the caller's org
      if (!(await assertProjectInOrg(supabase, source_project_id, orgId)) ||
          !(await assertProjectInOrg(supabase, target_project_id, orgId)))
        return err("Project not found in your organization", 404);

      const { data: sourceDTs, error: srcErr } = await supabase
        .from("device_types")
        .select("*")
        .eq("project_id", source_project_id);

      if (srcErr) return err(srcErr.message, 500);
      if (!sourceDTs?.length) return ok({ copied: 0, message: "No device types in source project" });

      const { data: existing } = await supabase
        .from("device_types")
        .select("legend_id")
        .eq("project_id", target_project_id);

      const existingIds = new Set((existing ?? []).map(d => d.legend_id));

      const toInsert = sourceDTs
        .filter(dt => !existingIds.has(dt.legend_id))
        .map(({ id, project_id, org_id, created_at, updated_at, ...rest }) => ({
          ...rest,
          project_id:        target_project_id,
          source_project_id: source_project_id
        }));

      if (!toInsert.length)
        return ok({ copied: 0, message: "All device types already exist in target project" });

      const { data: inserted, error: insErr } = await supabase
        .from("device_types")
        .insert(toInsert)
        .select("id, legend_id, name");

      if (insErr) return err(insErr.message, 500);
      return ok({ copied: inserted.length, device_types: inserted });
    }

    // ── Action: save device assembly (jsonb on device_types) ────
    if (action === "save_device_assembly") {
      const { project_id, id, assembly } = body;
      if (!project_id || !id) return err("project_id and id required");
      if (!(await assertProjectInOrg(supabase, project_id, orgId)))
        return err("Project not found in your organization", 404);

      const { error } = await supabase
        .from("device_types")
        .update({ assembly: assembly ?? {}, updated_at: new Date() })
        .eq("id", id)
        .eq("project_id", project_id);

      if (error) return err(error.message, 500);
      return ok({ saved: true, id });
    }

    // ── Action: delete a project and ALL its data (cascade) ─────
    if (action === "delete_project") {
      const { id, project_id } = body;
      const pid = id ?? project_id;
      if (!pid) return err("id required");
      if (!(await assertProjectInOrg(supabase, pid, orgId)))
        return err("Project not found in your organization", 404);

      const { data: pageRows, error: pgErr } = await supabase
        .from("pages").select("id").eq("project_id", pid);
      if (pgErr) return err(pgErr.message, 500);
      const pageIds = (pageRows ?? []).map((r) => r.id);

      const { data: asmRows } = await supabase
        .from("assembly_templates").select("id").eq("project_id", pid);
      const asmIds = (asmRows ?? []).map((r) => r.id);

      const steps = [];
      if (pageIds.length) {
        steps.push(supabase.from("device_instances").delete().in("page_id", pageIds));
        steps.push(supabase.from("detections").delete().in("page_id", pageIds));
        steps.push(supabase.from("detection_runs").delete().in("page_id", pageIds));
      }
      if (asmIds.length) {
        steps.push(supabase.from("assembly_parts").delete().in("assembly_id", asmIds));
      }
      steps.push(supabase.from("bom_items").delete().eq("project_id", pid));
      steps.push(supabase.from("demarcs").delete().eq("project_id", pid));
      steps.push(supabase.from("discovery_results").delete().eq("project_id", pid));
      steps.push(supabase.from("discovery_clusters").delete().eq("project_id", pid));
      steps.push(supabase.from("discovery_sessions").delete().eq("project_id", pid));
      steps.push(supabase.from("assembly_templates").delete().eq("project_id", pid));
      steps.push(supabase.from("batch_runs").delete().eq("project_id", pid));
      steps.push(supabase.from("project_pages").delete().eq("project_id", pid));
      steps.push(supabase.from("device_types").delete().eq("project_id", pid));
      steps.push(supabase.from("pages").delete().eq("project_id", pid));

      for (const step of steps) {
        const { error } = await step;
        if (error) return err(`cascade delete failed: ${error.message}`, 500);
      }

      const { error: projErr } = await supabase.from("projects").delete().eq("id", pid);
      if (projErr) return err(projErr.message, 500);

      return ok({ deleted: true, id: pid, pages_removed: pageIds.length });
    }

    // ── Action: update an existing project (e.g. mark as library) ──
    if (action === "update_project") {
      const { id, is_library, library_name, name, number, client, pdf_filename, pdf_page_count } = body;
      const project_id = body.project_id ?? id;
      if (!project_id) return err("project_id required");
      if (!(await assertProjectInOrg(supabase, project_id, orgId)))
        return err("Project not found in your organization", 404);

      const patch = { updated_at: new Date() };
      if (is_library     !== undefined) patch.is_library     = !!is_library;
      if (library_name   !== undefined) patch.library_name   = library_name || null;
      if (name           !== undefined) patch.name           = name;
      if (number         !== undefined) patch.number         = number;
      if (client         !== undefined) patch.client         = client;
      if (pdf_filename   !== undefined) patch.pdf_filename    = pdf_filename;
      if (pdf_page_count !== undefined) patch.pdf_page_count  = pdf_page_count;

      const { data, error } = await supabase
        .from("projects")
        .update(patch)
        .eq("id", project_id)
        .select("id, name, is_library, library_name")
        .single();

      if (error) return err(error.message, 500);
      return ok(data);
    }

    // ── Default: create project (stamped to caller's org) ──────
    const { name, number, client, pdf_filename } = body;
    if (!name) return err("name required");

    const { data, error } = await supabase
      .from("projects")
      .insert({ name, number, client, pdf_filename, org_id: orgId })
      .select("*")
      .single();

    if (error) return err(error.message, 500);
    return ok(data, 201);
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/projects" };
