// netlify/functions/set-page-role.js
// POST /api/set-page-role   Body: { page_id, page_role }
//
// Persists the HUMAN-ASSIGNED page role (plan|schedule|legend|detail|skip, or
// null/'' to clear back to needs-role). This is the source of truth for the
// page-role gate in the batch runner — there is no auto-classifier in the path.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

const ROLES = new Set(["plan", "schedule", "legend", "detail", "skip"]);

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { page_id, page_role } = body;
  if (!page_id) return err("page_id required");

  // null / "" clears the role; anything else must be a known role string.
  const role = (page_role === null || page_role === "") ? null : String(page_role);
  if (role !== null && !ROLES.has(role)) return err(`invalid page_role: ${role}`);

  const supabase = getSupabase();
  const { error } = await supabase.from("pages").update({ page_role: role }).eq("id", page_id);
  if (error) return err(error.message);

  return ok({ page_id, page_role: role });
}
