// netlify/functions/pass-describe.js
// Parse an llm_description → structured text_anchors JSON
// Also: generate an llm_description from example images (Pass A 2.0)
//
// POST /api/pass-describe
// Body (parse mode):
//   { project_id, device_type_id, llm_description }
// Body (generate mode):
//   { project_id, device_type_id, example_images: [base64,...], device_name }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, ok, err, CORS } from "./utils/clients.js";

const PARSE_SYSTEM = `You are a precise JSON extractor. Given a natural-language device description
written for an engineering drawing symbol detector, extract the text anchor information.
Return ONLY valid JSON — no markdown, no explanation.`;

const PARSE_PROMPT = (desc) => `Extract text anchor information from this telecom device description.

${desc}

CRITICAL RULES for telecom outlet devices:
One device instance = one symbol on the drawing. A device may have 1, 2, or 3 label types stacked:
  - DD label alone         (e.g. DD2)
  - DD + DV                (e.g. DD2 + DV1)
  - DD + DV + N            (e.g. DD2 + DV1 + N2)
  - DD + N                 (e.g. DD2 + N2)
  - DV + N                 (e.g. DV1 + N2)
  - DV alone               (e.g. DV1) — voice-only outlet
  - N alone                (e.g. N2)  — nurse station outlet

The DD label (DD1, DD2, DD3...) is the PRIMARY anchor — it uniquely identifies a data outlet.
DV labels (DV1, DV2...) are ASSOCIATED — they cluster with the nearest DD, never anchor alone
  UNLESS no DD is present (voice-only outlet, then DV becomes primary).
N labels (N2, N3...) are ASSOCIATED — they cluster with the nearest DD or DV.
  UNLESS the device description says N is the only label (nurse station), then N is primary.
WAP is always its own primary — never associated with anything.

NEVER put DV labels in primary if DD labels are also listed as primary.
NEVER put N labels in primary if DD or DV labels are also listed as primary.

Return exactly this JSON — no markdown, no preamble:
{
  "primary": ["exact label strings that uniquely identify ONE device instance"],
  "associated": ["labels that cluster with primary but do not anchor a device alone"],
  "label_suffix_is_port_count": true,
  "text_always_horizontal": true,
  "notes": "one sentence describing the device and its label pattern"
}

Examples:
- Data/VoIP outlet (DD2/DV1/N2):  primary=["DD1","DD2","DD3"]  associated=["DV1","DV2","N2","N3"]
- WAP:                             primary=["WAP"]               associated=[]
- Nurse station (N only):          primary=["N1","N2","N3"]      associated=[]
- Voice-only outlet (DV only):     primary=["DV1","DV2"]         associated=[]
If a field is not determinable, use null.`;

const GENERATE_SYSTEM = `You are an expert engineering drawing analyst. Given one or more example images 
of a device symbol from an engineering drawing, write a precise machine-readable description
that will be used by an automated symbol detector. Return ONLY valid JSON — no markdown.`;

const GENERATE_PROMPT = (name) => `These images show examples of the device: "${name}"

Write a complete llm_description for this device symbol — a precise fingerprint for automated detection.
Also extract the text_anchors.

Return exactly this JSON:
{
  "llm_description": "Multi-line description covering:\\nSHAPE: ...\\nSIZE: ...\\nTEXT ANCHORS: ...\\nTEXT ORIENTATION: ...\\nLABEL PATTERN: ...\\nORIENTATION: ...\\nEXCLUSIONS: ...\\nLOOK-ALIKES: ...",
  "text_anchors": {
    "primary": [],
    "associated": [],
    "label_suffix_is_port_count": false,
    "text_always_horizontal": true,
    "notes": ""
  }
}

CRITICAL RULES for text_anchors:
- primary = label strings that ALONE identify one device instance on a drawing
- associated = labels that appear near primary but never anchor a device by themselves
- For data outlets: DD1/DD2/DD3 → primary. DV1/DV2/N2/N3 → associated. NEVER mix.
- For WAP: WAP → primary. Nothing → associated.
- For nurse stations (N-only): N1/N2/N3 → primary. Nothing → associated.
- NEVER put DV or N in primary if DD is also primary for the same device.

Rules for llm_description:
- SHAPE: exact geometry (triangle/rectangle/circle/compound), fill (solid/outline/none), stroke color
- SIZE: consistent size in mm on the drawing, or describe if variable  
- TEXT ANCHORS: the exact label strings always adjacent to this symbol
- TEXT ORIENTATION: whether labels rotate with symbol or stay horizontal
- LABEL PATTERN: how many strings, stacked or inline, any suffix rules
- ORIENTATION: can symbol rotate freely, or is it fixed direction
- EXCLUSIONS: where NOT to count (legend box, keynote callouts, detail insets)
- LOOK-ALIKES: other symbols that could be confused, and the distinguishing detail`;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, device_type_id, llm_description, example_images, device_name } = body;
  if (!project_id || !device_type_id)
    return err("project_id and device_type_id required");

  const supabase  = getSupabase();
  const anthropic = getAnthropic();

  // ── Mode: PARSE existing llm_description ─────────────────────
  if (llm_description) {
    let parsed;
    try {
      const msg = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 512,
        system:     PARSE_SYSTEM,
        messages: [{ role: "user", content: PARSE_PROMPT(llm_description) }]
      });
      const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(raw);
    } catch (e) {
      return err(`Parse error: ${e.message}`, 502);
    }

    // Save both fields to device_types
    const { error: upErr } = await supabase
      .from("device_types")
      .update({ llm_description, text_anchors: parsed, updated_at: new Date() })
      .eq("id", device_type_id)
      .eq("project_id", project_id);

    if (upErr) return err(`DB error: ${upErr.message}`, 500);

    return ok({ mode: "parse", device_type_id, text_anchors: parsed });
  }

  // ── Mode: GENERATE from example images ───────────────────────
  if (example_images?.length) {
    if (!device_name) return err("device_name required for generate mode");

    function detectMediaType(b64) {
      if (b64.startsWith("/9j/"))  return "image/jpeg";
      if (b64.startsWith("iVBOR")) return "image/png";
      return "image/jpeg";
    }

    const imageContent = example_images.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: detectMediaType(b64), data: b64 }
    }));

    let result;
    try {
      const msg = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 1024,
        system:     GENERATE_SYSTEM,
        messages: [{
          role: "user",
          content: [...imageContent, { type: "text", text: GENERATE_PROMPT(device_name) }]
        }]
      });
      const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
      result = JSON.parse(raw);
    } catch (e) {
      return err(`Generate error: ${e.message}`, 502);
    }

    // Save to device_types
    const { error: upErr } = await supabase
      .from("device_types")
      .update({
        llm_description: result.llm_description,
        text_anchors:    result.text_anchors,
        updated_at:      new Date()
      })
      .eq("id", device_type_id)
      .eq("project_id", project_id);

    if (upErr) return err(`DB error: ${upErr.message}`, 500);

    return ok({
      mode:            "generate",
      device_type_id,
      llm_description: result.llm_description,
      text_anchors:    result.text_anchors
    });
  }

  return err("Provide either llm_description (parse) or example_images (generate)");
}

export const config = { path: "/api/pass-describe" };
