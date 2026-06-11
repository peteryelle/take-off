// netlify/functions/projects.js
// GET  /api/projects                     — list all projects
// POST /api/projects { name, ... }       — create a new project
// POST /api/projects { action: ... }     — device type management actions:
//   action: upsert_device_type           — create or update a device type
//   action: delete_device_type           — delete a device type
//   action: copy_device_types            — copy device types between projects
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });

  const supabase = getSupabase();

  // ── GET — list projects ───────────────────────────────────────
  if (req.method === "GET") {
    // Try the summary view first, fall back to base table
    const { data: viewData, error: viewErr } = await supabase
      .from("v_project_list")
      .select("*");

    if (!viewErr && viewData) return ok(viewData);

    // Fallback: base table
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, project_number, client, pdf_filename, pdf_page_count, created_at, updated_at, last_run_at")
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
        // Update existing
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
        // Insert new
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

      // Load source device types
      const { data: sourceDTs, error: srcErr } = await supabase
        .from("device_types")
        .select("*")
        .eq("project_id", source_project_id);

      if (srcErr) return err(srcErr.message, 500);
      if (!sourceDTs?.length) return ok({ copied: 0, message: "No device types in source project" });

      // Load existing legend_ids in target to avoid dupes
      const { data: existing } = await supabase
        .from("device_types")
        .select("legend_id")
        .eq("project_id", target_project_id);

      const existingIds = new Set((existing ?? []).map(d => d.legend_id));

      // Copy rows that don't already exist in target
      const toInsert = sourceDTs
        .filter(dt => !existingIds.has(dt.legend_id))
        .map(({ id, project_id, created_at, updated_at, ...rest }) => ({
          ...rest,
          project_id:       target_project_id,
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
    // Replace the whole assembly object for one device type. Used by the Assembly
    // modal's Save and by the bulk Excel import (one call per device). updated_at is
    // set explicitly — device_types has no auto-update trigger.
    if (action === "save_device_assembly") {
      const { project_id, id, assembly } = body;
      if (!project_id || !id) return err("project_id and id required");

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

      // Page ids for this project — needed for page-scoped child tables.
      const { data: pageRows, error: pgErr } = await supabase
        .from("pages").select("id").eq("project_id", pid);
      if (pgErr) return err(pgErr.message, 500);
      const pageIds = (pageRows ?? []).map((r) => r.id);

      // Assembly ids — needed to clear assembly_parts before templates.
      const { data: asmRows } = await supabase
        .from("assembly_templates").select("id").eq("project_id", pid);
      const asmIds = (asmRows ?? []).map((r) => r.id);

      // Delete children first, deepest dependency to shallowest. Each guarded.
      const steps = [];
      if (pageIds.length) {
        steps.push(supabase.from("device_instances").delete().in("page_id", pageIds));
        steps.push(supabase.from("detections").delete().in("page_id", pageIds));
        steps.push(supabase.from("detection_runs").delete().in("page_id", pageIds));
      }
      if (asmIds.length) {
        steps.push(supabase.from("assembly_parts").delete().in("assembly_id", asmIds));
      }
      // project-scoped children
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

      // Run cascades in order; abort on first real error.
      for (const step of steps) {
        const { error } = await step;
        if (error) return err(`cascade delete failed: ${error.message}`, 500);
      }

      // Finally the project row itself.
      const { error: projErr } = await supabase.from("projects").delete().eq("id", pid);
      if (projErr) return err(projErr.message, 500);

      return ok({ deleted: true, id: pid, pages_removed: pageIds.length });
    }

    // ── Action: update an existing project (e.g. mark as library) ──
    if (action === "update_project") {
      const { id, is_library, library_name, name, number, client, pdf_filename, pdf_page_count } = body;
      const project_id = body.project_id ?? id;   // accept either key
      if (!project_id) return err("project_id required");
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

    // ── Default: create project ────────────────────────────────
    const { name, number, client, pdf_filename } = body;
    if (!name) return err("name required");

    const { data, error } = await supabase
      .from("projects")
      .insert({ name, number, client, pdf_filename })
      .select("*")
      .single();

    if (error) return err(error.message, 500);
    return ok(data, 201);
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/projects" };
