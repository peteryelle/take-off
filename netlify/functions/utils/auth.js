// netlify/functions/utils/auth.js
// Tenant enforcement for the function layer.
//
// The functions use the service-role key, which BYPASSES RLS — so RLS is only
// an insurance backstop. The real tenant boundary is here: every request must
// carry a valid Supabase auth token, from which we resolve the caller's org,
// and every project/page the request touches must belong to that org.
//
// Usage in a handler:
//   const gate = await requireOrg(req);
//   if (gate.error) return gate.error;          // 401/403 Response
//   const { supabase, orgId } = gate;
//   // for any client-supplied project_id:
//   if (!(await assertProjectInOrg(supabase, project_id, orgId)))
//     return err("Not found", 404);
// ─────────────────────────────────────────────────────────────────

import { getSupabase, err } from "./clients.js";

function bearer(req) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

// Verifies the caller's JWT and resolves their single org.
// Returns { supabase, orgId, role, user } on success, or { error: Response }.
export async function requireOrg(req) {
  const token = bearer(req);
  if (!token) return { error: err("Not authenticated", 401) };

  const supabase = getSupabase(); // service-role; bypasses RLS for the lookups below

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (uErr || !user) return { error: err("Invalid or expired session", 401) };

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("user_id", user.id)
    .single();

  if (pErr || !profile) return { error: err("No organization for this user", 403) };

  return { supabase, orgId: profile.org_id, role: profile.role, user };
}

// True iff this project belongs to the caller's org. Use before any
// project-scoped read/write that takes a client-supplied project_id.
export async function assertProjectInOrg(supabase, projectId, orgId) {
  if (!projectId) return false;
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("org_id", orgId)
    .maybeSingle();
  return !error && !!data;
}

// True iff this page belongs to the caller's org. Use in page-scoped functions.
export async function assertPageInOrg(supabase, pageId, orgId) {
  if (!pageId) return false;
  const { data, error } = await supabase
    .from("pages")
    .select("id")
    .eq("id", pageId)
    .eq("org_id", orgId)
    .maybeSingle();
  return !error && !!data;
}

// True iff this project is NOT locked (accepted_final_run_at is null).
// Call this in every endpoint that inserts/deletes device_instances rows —
// i.e. anything that changes device COUNTS — right after assertProjectInOrg.
// Endpoints that only edit metadata (flags, cull reason, xy, catalog
// assignment, pricing multiplier) are out of scope; the lock only guards
// counts, per the design decision, not every mutation on the project.
export async function assertProjectUnlocked(supabase, projectId) {
  if (!projectId) return true; // caller's own project-existence check handles this case
  const { data, error } = await supabase
    .from("projects")
    .select("accepted_final_run_at")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) return true; // let the caller's own not-found check fire
  return data.accepted_final_run_at == null;
}

// Same check, but resolves project_id from a page_id first — for endpoints
// (pass-extract, set-page-role, pass-visual-augment) that only receive a
// page_id, not a project_id, in the request body.
export async function assertProjectUnlockedForPage(supabase, pageId) {
  if (!pageId) return true;
  const { data: page, error: pageErr } = await supabase
    .from("pages")
    .select("project_id")
    .eq("id", pageId)
    .maybeSingle();
  if (pageErr || !page) return true;
  return assertProjectUnlocked(supabase, page.project_id);
}

// ── Device-type library resolution ──────────────────────────────────
// A project can sync its device_types (and the assembly/labor jsonb carried
// on each row) from another project marked is_library — see
// projects.library_project_id. When linked, matching device_types (by
// legend_id) are remapped into the library and the project's own rows
// deleted — see linkProjectToLibrary below for the full matching/remap
// logic. From then on device_types for a synced project live under the
// library's project_id. Every function that reads or writes device_types by
// project_id must resolve through this first, or a synced project will
// silently see/edit nothing (its own rows are gone) instead of the
// library's.
//
// This is write-through by design: editing device types from a synced
// project's UI writes to the library's rows directly, visible to every other
// project synced to the same library. There is no per-project override.
export async function resolveDeviceTypesProjectId(supabase, projectId) {
  if (!projectId) return projectId;
  const { data, error } = await supabase
    .from("projects")
    .select("library_project_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) return projectId; // let the caller's own not-found check fire
  return data.library_project_id ?? projectId;
}

// Links `projectId` to `libraryProjectId` as its device-type library, or
// unlinks it if libraryProjectId is null. Encapsulates the multi-step
// operation so projects.js's update_project stays a thin dispatcher:
//   - Linking: this project's device_types are matched to the library's by
//     legend_id (the field proven stable across projects — see the comment
//     above the matching loop below). Matched types have their
//     device_instances re-pointed to the library's row and the project's own
//     row deleted — counts, positions, confidence all untouched, same
//     pattern as the proven merge_device_type action. Unmatched types block
//     the link by default (returns error: "device_type_mismatch" with the
//     list) unless `force` is true, in which case they're left completely
//     alone — still their own project-local row, invisible in the synced
//     device-types.html view from then on, but their instances keep working.
//   - Unlinking: fork — the library's current device_types rows are copied
//     into the project as its own, so it doesn't end up with zero types.
//
// Validation performed here (org boundary is the caller's responsibility via
// assertProjectInOrg before calling this):
//   - libraryProjectId, if set, must belong to the same org, have
//     is_library = true, and itself have library_project_id IS NULL (no
//     chains — a library can't itself be synced to another library).
export async function linkProjectToLibrary(supabase, orgId, projectId, libraryProjectId, force = false) {
  // ── Unlink ──
  if (libraryProjectId === null) {
    const { data: proj, error: projErr } = await supabase
      .from("projects")
      .select("library_project_id")
      .eq("id", projectId)
      .single();
    if (projErr || !proj) return { error: "Project not found" };
    const currentLibraryId = proj.library_project_id;
    if (!currentLibraryId) return { ok: true, forked: 0 }; // already unlinked, no-op

    const { data: libTypes, error: libErr } = await supabase
      .from("device_types")
      .select("legend_id, name, human_description, example_image_base64, detection_config, assembly, labor")
      .eq("project_id", currentLibraryId);
    if (libErr) return { error: libErr.message };

    let forked = 0;
    if ((libTypes ?? []).length) {
      const toInsert = libTypes.map((t) => ({ ...t, project_id: projectId, updated_at: new Date() }));
      const { data: inserted, error: insErr } = await supabase
        .from("device_types").insert(toInsert).select("id");
      if (insErr) return { error: insErr.message };
      forked = inserted?.length ?? 0;
    }

    const { error: updErr } = await supabase
      .from("projects")
      .update({ library_project_id: null, updated_at: new Date() })
      .eq("id", projectId);
    if (updErr) return { error: updErr.message };

    return { ok: true, forked };
  }

  // ── Link ──
  const { data: lib, error: libErr } = await supabase
    .from("projects")
    .select("id, is_library, library_project_id")
    .eq("id", libraryProjectId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (libErr || !lib) return { error: "Library project not found in your organization" };
  if (!lib.is_library) return { error: "Target project is not marked as a library" };
  if (lib.library_project_id) return { error: "Target project is itself synced to another library — chaining libraries is not supported" };
  if (libraryProjectId === projectId) return { error: "A project cannot be its own library" };

  // Match this project's own device_types to the library's by legend_id —
  // the one field proven stable across projects (copy_device_types already
  // dedupes on it; names drift with manual edits, legend_id doesn't).
  const { data: ownTypes, error: ownTypesErr } = await supabase
    .from("device_types").select("id, legend_id, name").eq("project_id", projectId);
  if (ownTypesErr) return { error: ownTypesErr.message };

  const { data: libTypesForMatch, error: libMatchErr } = await supabase
    .from("device_types").select("id, legend_id").eq("project_id", libraryProjectId);
  if (libMatchErr) return { error: libMatchErr.message };
  const libByLegendId = new Map((libTypesForMatch ?? []).map((t) => [t.legend_id, t.id]));

  const matched = [];   // { ownId, ownName, libId }
  const unmatched = []; // { ownId, ownName, legend_id }
  for (const t of ownTypes ?? []) {
    const libId = libByLegendId.get(t.legend_id);
    if (libId) matched.push({ ownId: t.id, ownName: t.name, libId });
    else unmatched.push({ ownId: t.id, ownName: t.name, legend_id: t.legend_id });
  }

  // Unmatched types are blocked by default — a device that fails to remap
  // keeps its old, project-local config forever unless someone notices,
  // which is exactly the cross-project inconsistency this feature exists to
  // avoid. Surface it and require an explicit force to proceed anyway.
  if (unmatched.length && !force) {
    return {
      error: "device_type_mismatch",
      unmatched: unmatched.map((u) => ({ name: u.ownName, legend_id: u.legend_id })),
      message: `${unmatched.length} device type(s) have no match in the library by legend_id — ` +
        `resolve the mismatch or retry with force to leave them unmapped: ` +
        unmatched.map((u) => `"${u.ownName}" (${u.legend_id})`).join(", "),
    };
  }

  // Remap: for each matched type, re-point its device_instances to the
  // library's row, then delete the now-empty project-local row — same
  // pattern as the proven merge_device_type action, just batched. Unmatched
  // types (only reachable with force) are left completely untouched: their
  // instances keep pointing at their own project-local device_types row.
  let instancesMoved = 0;
  for (const m of matched) {
    const { count, error: countErr } = await supabase
      .from("device_instances").select("id", { count: "exact", head: true }).eq("device_type_id", m.ownId);
    if (countErr) return { error: countErr.message };
    instancesMoved += count ?? 0;

    const { error: remapErr } = await supabase
      .from("device_instances").update({ device_type_id: m.libId }).eq("device_type_id", m.ownId);
    if (remapErr) return { error: remapErr.message };

    const { error: delTypeErr } = await supabase.from("device_types").delete().eq("id", m.ownId);
    if (delTypeErr) return { error: delTypeErr.message };
  }

  const { error: updErr } = await supabase
    .from("projects")
    .update({ library_project_id: libraryProjectId, updated_at: new Date() })
    .eq("id", projectId);
  if (updErr) return { error: updErr.message };

  return {
    ok: true,
    matched: matched.length,
    instances_remapped: instancesMoved,
    unmatched: unmatched.map((u) => ({ name: u.ownName, legend_id: u.legend_id })),
  };
}
