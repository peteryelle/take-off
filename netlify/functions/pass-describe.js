// netlify/functions/pass-describe.js
// Generate an llm_description from example images (Pass A 2.0)
// Extract text_anchors deterministically from the description (no LLM)
//
// POST /api/pass-describe
// Body (parse mode):
//   { project_id, device_type_id, llm_description }
// Body (generate mode):
//   { project_id, device_type_id, example_images: [base64,...], device_name }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg, resolveDeviceTypesProjectId } from "./utils/auth.js";
// ── Deterministic text_anchors extraction ────────────────────────
// Rules-based — Claude NEVER controls text_anchors.
// Claude writes the visual description; these rules extract the anchors.
function extractTextAnchors(llmDescription) {
  const desc = (llmDescription ?? '').toUpperCase();

  const PRIMARY_PATTERNS = [
    { test: /\bWAP\b/,
      primary: ['WAP'], associated: [] },

    { test: /\b180\b/,
      primary: ['180'], associated: [] },

    { test: /\bPTZ\b/,
      primary: ['PTZ'], associated: [] },

    // Data outlet: DD present → DD is primary, DV+N are associated
    { test: /\bDD[1-9]\b/,
      primary: ['DD1','DD2','DD3'],
      associated: ['DV1','DV2','N1','N2','N3'] },

    // Nurse station: N-only (no DD, no DV)
    { test: /\bN[1-9]\b.*ONLY|ONLY.*\bN[1-9]\b|NURSE|N-LABEL ONLY|SOLE LABEL.*N/,
      primary: ['N1','N2','N3','N4','N5'], associated: [] },

    // Voice-only outlet: DV-only (no DD)
    { test: /\bDV[1-9]\b.*ONLY|ONLY.*\bDV[1-9]\b|VOICE.ONLY|VOICE ONLY/,
      primary: ['DV1','DV2'], associated: [] },
  ];

  for (const pattern of PRIMARY_PATTERNS) {
    if (pattern.test.test(desc)) {
      const hasPortCount = /DD[1-9]/.test(desc) &&
                           /SUFFIX|PORT COUNT|DIGIT/.test(desc);
      return {
        primary:                    pattern.primary,
        associated:                 pattern.associated,
        label_suffix_is_port_count: hasPortCount,
        text_always_horizontal:     true,
        notes:                      inferNotes(desc, pattern.primary)
      };
    }
  }

  // No match — flag for manual review
  return {
    primary:                    [],
    associated:                 [],
    label_suffix_is_port_count: false,
    text_always_horizontal:     true,
    notes: 'No standard label pattern detected — verify text_anchors manually'
  };
}

function inferNotes(desc, primary) {
  if (primary.includes('WAP'))  return 'WAP — rectangle with arrowhead, always 2 CAT6A runs';
  if (primary.includes('DD1'))  return 'Data/VoIP outlet — DD suffix = port count, DV = voice, N = node';
  if (primary.includes('180'))  return 'Security camera 180° — degree symbol may be non-ASCII in PDF';
  if (primary.includes('N1'))   return 'Nurse station — N label only, no DD or DV present';
  if (primary.includes('DV1'))  return 'Voice-only outlet — DV label only, no DD present';
  return '';
}

// ── Generate prompt ───────────────────────────────────────────────
const GENERATE_SYSTEM = `You are an expert engineering drawing analyst. Given one or more example
images of a device symbol from an engineering drawing, write a precise machine-readable description
that will be used by an automated symbol detector. Return ONLY valid JSON — no markdown, no preamble.`;

const GENERATE_PROMPT = (name) => `These images show examples of the device symbol: "${name}"

Write a complete llm_description — a precise visual fingerprint for automated detection.

Return exactly this JSON:
{
  "llm_description": "Multi-line description:\\nSHAPE: ...\\nSIZE: ...\\nTEXT ANCHORS: ...\\nTEXT ORIENTATION: ...\\nLABEL PATTERN: ...\\nORIENTATION: ...\\nEXCLUSIONS: ...\\nLOOK-ALIKES: ..."
}

Rules for each section:
- SHAPE: exact geometry (triangle/rectangle/circle/compound), fill (solid/outline/none), stroke color
- SIZE: consistent size in mm on drawing, or variable
- TEXT ANCHORS: exact label strings always adjacent (e.g. DD2, DV1, N2, WAP, 180)
- TEXT ORIENTATION: do labels rotate with the symbol or always stay horizontal?
- LABEL PATTERN: how many strings, stacked or inline, suffix rules (e.g. DD2 digit = port count)
- ORIENTATION: can the symbol rotate freely, or fixed direction?
- EXCLUSIONS: where NOT to count (legend box, keynote callouts, detail insets, title block)
- LOOK-ALIKES: other symbols that could be confused, and the distinguishing detail`;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, device_type_id, llm_description, example_images, device_name } = body;
  if (!project_id || !device_type_id)
    return err("project_id and device_type_id required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  const anthropic = getAnthropic();

  // Write-through: a synced project's device_types rows live under the
  // library's project_id — resolve so this update lands on the real row
  // instead of silently matching zero rows.
  const dtProjectId = await resolveDeviceTypesProjectId(supabase, project_id);

  // ── Mode: PARSE existing llm_description ─────────────────────────
  // Deterministic — no Claude call. Rules extract text_anchors from description.
  if (llm_description) {
    const text_anchors = extractTextAnchors(llm_description);

    const { error: upErr } = await supabase
      .from("device_types")
      .update({ llm_description, text_anchors, updated_at: new Date() })
      .eq("id", device_type_id)
      .eq("project_id", dtProjectId);

    if (upErr) return err(`DB error: ${upErr.message}`, 500);

    return ok({ mode: "parse", device_type_id, text_anchors });
  }

  // ── Mode: GENERATE from example images ───────────────────────────
  // Claude generates the llm_description from images.
  // text_anchors are then extracted deterministically — Claude never sets them.
  if (example_images?.length) {
    if (!device_name) return err("device_name required for generate mode");

    function detectMediaType(b64) {
      if (b64.startsWith("/9j/"))  return "image/jpeg";
      if (b64.startsWith("iVBOR")) return "image/png";
      return "image/jpeg";
    }

    const imageContent = example_images.map(b64 => ({
      type:   "image",
      source: { type: "base64", media_type: detectMediaType(b64), data: b64 }
    }));

    let result;
    try {
      const msg = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 1024,
        system:     GENERATE_SYSTEM,
        messages: [{
          role:    "user",
          content: [...imageContent, { type: "text", text: GENERATE_PROMPT(device_name) }]
        }]
      });
      const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
      result = JSON.parse(raw);
    } catch (e) {
      return err(`Generate error: ${e.message}`, 502);
    }

    // Deterministic text_anchors — ignore anything Claude may have returned
    const text_anchors = extractTextAnchors(result.llm_description);

    const { error: upErr } = await supabase
      .from("device_types")
      .update({ llm_description: result.llm_description, text_anchors, updated_at: new Date() })
      .eq("id", device_type_id)
      .eq("project_id", dtProjectId);

    if (upErr) return err(`DB error: ${upErr.message}`, 500);

    return ok({ mode: "generate", device_type_id,
                llm_description: result.llm_description, text_anchors });
  }

  return err("Provide either llm_description (parse) or example_images (generate)");
}

export const config = { path: "/api/pass-describe" };
