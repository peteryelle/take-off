// netlify/functions/wf4-symbol.js
// WF4 copy of pass-symbol.js — the MODEL FALLBACK for symbol detection.
// On vector sheets the browser matches symbols from PDF geometry for free;
// this endpoint is only called when a sheet is raster, a type has no vector
// template, or the vector match came back empty. METERED: N_STRIPS model calls
// per page per device type. It just runs — each call is logged per page for
// the admin page (utils/metered.js). The same page image + same type
// description again reuses the stored result for free (utils/pass-reuse.js).
//
// POST /api/wf/wf4/symbol   { page_id, device_type_id, page_image_base64 }
// Prompt, model, strip slicing, dedup and response shape are unchanged.
// ─────────────────────────────────────────────────────────────────
//
// Original notes (pass-symbol.js):
// Step 7 — symbol detector (raster/vision, text-only matching reference).
//
// Replaces the bespoke pass-visual-augment merge path. This endpoint does ONE job:
// look at the page and report every glyph that matches a device type's visual
// description, as contract symbol instances { type, x, y, confidence }. It does NOT
// dedup, merge against the text layer, compute distance, or write device_instances —
// reconcile owns all of that. The caller passes the returned symbol_instances into
// pass-extract / pass-batch, where buildDeviceList -> reconcile folds them onto the
// labeled/scheduled devices (SNAP) and surfaces genuinely unlabeled glyphs as flags.
//
// POST /api/pass-symbol
// Body: { page_id, device_type_id, page_image_base64 }
// Returns: { pass:"symbol_detect", type, device_type_id, device_name, strips,
//            symbol_instances:[{ type, x, y, confidence }] }
//
// Budget guard: the page is sliced into N_STRIPS and the strips run as ONE parallel
// fan-out (Promise.all) — wall-clock ~= the slowest strip, not N sequential calls.
// Never spawn a call per candidate; the strip is the batch unit.
// ─────────────────────────────────────────────────────────────────

import { getAnthropic, ok, err, CORS } from "./utils/clients.js";
import { requireOrg } from "./utils/auth.js";
import { td } from "./utils/takeoff-db.js";
import { makeCroppedStrips, toFullCoords, dedup } from "./utils/strips.js";
import { meteredCreate } from "./utils/metered.js";
import { sha256, variantKey, findStored, saveStored, logReuse } from "./utils/pass-reuse.js";

const N_STRIPS = 8;
const MODEL    = "claude-sonnet-4-5";
const PROMPT_VERSION = "symbol.v1";   // bump when the prompt changes, so stored results aren't reused

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { page_id, device_type_id, page_image_base64 } = body;
  if (!page_id || !device_type_id || !page_image_base64)
    return err("page_id, device_type_id, page_image_base64 required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  const { data: page } = await db.from("pages")
    .select("id, org_id, project_id, drawing_x0, drawing_y0, drawing_x1, drawing_y1").eq("id", page_id).maybeSingle();
  if (!page || String(page.org_id) !== String(orgId)) return err("Page not found", 404);
  // The type must belong to this project's device library.
  const { data: project } = await db.from("projects").select("device_library_id").eq("id", page.project_id).single();
  const { data: device, error: devErr } = await db.from("device_types").select("*")
    .eq("id", device_type_id).eq("library_id", project?.device_library_id ?? -1).maybeSingle();
  if (devErr || !device) return err("Device type not found in this project's library", 404);

  // Drawing bounds (already detected by Pass B) — cropping strips to just the plan
  // area means all N_STRIPS worth of attention goes to where devices actually live,
  // instead of wasting slots on title block / notes columns. Matches the pattern
  // pass-b2-scan.js already uses for its device pre-scan.
  const drawingBounds = (page?.drawing_x0 != null) ? {
    x0: page.drawing_x0, y0: page.drawing_y0 ?? 0, x1: page.drawing_x1, y1: page.drawing_y1 ?? 1
  } : { x0: 0, y0: 0, x1: 1, y1: 1 };

  const cfg  = device.detection_config || {};
  const type = cfg.type || device.name;            // the catalog type string reconcile joins on
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];

  // Text-only matching reference (the 7b decision): drive off the engineer's
  // description. symbol_template stays null until the legend-crop fast-follow.
  const visualDesc = device.llm_description ?? device.human_description ?? device.notes;
  if (!visualDesc) {
    return ok({ pass: "symbol_detect", type, device_type_id, device_name: device.name,
                strips: 0, symbol_instances: [], skipped: "no visual description on this type" });
  }

  const PROMPT = (strip) =>
`You are scanning strip ${strip.index + 1} of ${N_STRIPS} of a telecom / security floor plan.

Find every glyph on the drawing that matches this device symbol:
${visualDesc}

This symbol can be small (a few mm at drawing scale) and easy to overlook among other
symbols, room labels, and line work — look carefully at every room and corridor rather
than stopping at the first clear match. But only report a glyph you can clearly
identify against the description above — do NOT guess, and do NOT infer extra
instances near a match just because the area seems busy. If a mark is ambiguous or
only loosely resembles the description, report it at low confidence rather than
omitting it or inflating it into a firm match.

Rules:
- Match the visual description precisely — shape, size, fill, internal marks.
- Do NOT count symbols in the legend, title block, or detail / blow-up insets.
- Do NOT count keynote callout bubbles or section / detail reference markers.
- Report a glyph even if it has no text label next to it — unlabeled glyphs are the point.
- confidence: high = clearly matches description, medium = likely match, low = possible but uncertain.
- x_frac and y_frac_in_strip are 0–1 relative to THIS STRIP only.

Return ONLY raw JSON (no markdown fences):
{ "glyphs": [ { "x_frac": 0.35, "y_frac_in_strip": 0.4, "confidence": "high|medium|low" } ] }
If none: { "glyphs": [] }`;

  const ctxBase = { supabase, orgId, projectId: page.project_id, pageId: page_id, pass: "symbol", userId: user?.id };
  const reuseKey = { orgId, pass: "symbol", inputHash: sha256(page_image_base64),
    variant: variantKey([PROMPT_VERSION, MODEL, N_STRIPS, type, visualDesc, drawingBounds]) };
  const stored = await findStored(supabase, reuseKey);
  if (stored) {
    await logReuse(supabase, { ...ctxBase, detail: device.name }, MODEL);
    return ok({ ...stored, reused: true });
  }
  const anthropic = getAnthropic();

  let strips;
  try { strips = await makeCroppedStrips(page_image_base64, drawingBounds, N_STRIPS, 0.12); }
  catch (e) { return err(`Strip generation failed: ${e.message}`, 500); }

  // Single parallel fan-out — the timeout guard. One slow strip, not eight in series.
  const stripResults = await Promise.all(strips.map(async (strip) => {
    try {
      const msg = await meteredCreate(anthropic, {
        model: MODEL,
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: strip.base64 } },
            { type: "text",  text: PROMPT(strip) }
          ]
        }]
      }, { ...ctxBase, detail: `${device.name} strip ${strip.index + 1}/${N_STRIPS}` });
      const clean  = msg.content[0].text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      return { strip, found: parsed.glyphs ?? [] };
    } catch {
      return { strip, found: [], failed: true };   // a failed/garbled strip yields nothing, never throws
    }
  }));

  // Lift strip-local fractions to full-image normalized coords and tag with the type.
  // Overlapping strips (makeCroppedStrips, 12%) mean a glyph sitting in the overlap
  // band is legitimately reported by TWO strips — dedup here BEFORE reconcile, since
  // reconcile's SNAP deliberately refuses to merge two symbol-only instances of the
  // same type together (that guard exists to keep genuinely distinct unlabeled
  // glyphs from being conflated into one device), so an un-deduped seam duplicate
  // would silently double-count instead of being caught downstream.
  const raw_instances = [];
  for (const { strip, found } of stripResults) {
    for (const g of found) {
      const c = toFullCoords(strip, g.x_frac, g.y_frac_in_strip);
      raw_instances.push({
        type,
        x: parseFloat(c.x.toFixed(4)),
        y: parseFloat(c.y.toFixed(4)),
        confidence: g.confidence ?? "medium"
      });
    }
  }
  const { kept: symbol_instances } = dedup(raw_instances, 0.015);

  const response = {
    pass: "symbol_detect",
    type, device_type_id, device_name: device.name,
    strips: N_STRIPS,
    has_symbol_source: sources.includes("symbol"),
    symbol_instances
  };
  // Store only when every strip answered — a partial result must not be reused.
  if (stripResults.every((r) => !r.failed)) await saveStored(supabase, { ...reuseKey, result: response, pageId: page_id });
  return ok({ ...response, reused: false });
}

export const config = { path: "/api/wf/wf4/symbol" };
