// netlify/functions/utils/takeoff-db.js
// Access to the v2 `takeoff` schema.
//
// The service-role client bypasses RLS, so — exactly as in utils/auth.js —
// the tenant boundary is enforced here: every v2 project a request touches
// must belong to the caller's org.
//
// Requires `takeoff` in Supabase → API settings → Exposed schemas; without it
// every call returns "The schema must be one of the following: ...".
// ─────────────────────────────────────────────────────────────────

export function td(supabase) {
  return supabase.schema('takeoff');
}

// True iff this v2 project belongs to the caller's org.
export async function assertWfProjectInOrg(supabase, projectId, orgId) {
  if (!projectId) return false;
  const { data, error } = await td(supabase)
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', orgId)
    .maybeSingle();
  return !error && !!data;
}
