// netlify/functions/utils/clients.js
// Shared Supabase and Anthropic client initialisation
// ─────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

// ── Supabase ──────────────────────────────────────────────────────
// Uses the service-role key (server-side only — never expose to browser)
export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

// ── Anthropic ─────────────────────────────────────────────────────
export function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
}

// ── CORS headers ──────────────────────────────────────────────────
export const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Content-Type":                 "application/json"
};

export function ok(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS });
}

// ── System prompt (shared across all passes) ──────────────────────
export const SYSTEM_PROMPT = `You are an expert technical drawing analyst specializing in telecom, security, and inside plant schematics. You analyze engineering drawings to extract device information. Return ONLY valid JSON — no markdown, no preamble, no explanation.`;
