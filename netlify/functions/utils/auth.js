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
