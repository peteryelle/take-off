// netlify/functions/projects.js
// GET  /api/projects          — list all projects
// POST /api/projects          — create a new project
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });

  const supabase = getSupabase();

  // ── GET — list projects ───────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, number, client, pdf_filename, created_at")
      .order("created_at", { ascending: false });

    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — create project ─────────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

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
