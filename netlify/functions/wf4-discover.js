// netlify/functions/wf4-discover.js
// WF4 copy of the parts of pass-discover.js (+ delete_device_type from
// projects.js) that the Discover crop tool (discover.html) actually uses.
// The other 12 pass-discover actions (the old strip-scan discovery-session
// flow) are called by no screen and are not carried over.
//
// POST /api/wf/wf4/discover  { action, project_id, ... }
//   analyze_crop         { crop_image, legend_image? }   METERED: 1-2 vision calls.
//                          Describes the cropped symbol; the legend only SUGGESTS a
//                          name. The same crop (+ legend) again reuses the stored
//                          result for free.
//   build_device         { legend_entry, all_instances, drawing_crop_base64?, ... }
//                          METERED: 1 text call (writes the detection description).
//   build_symbol_device  { name, description?, symbol_template, match_count, ... }
//                          METERED: 1 text call. The signature is derived in the browser.
//   delete_device_type   { id, cascade? }   free; 409 while counted devices exist.
//
// Every model call just runs and is logged per project for the admin page
// (utils/metered.js). Prompts, model and parsing are unchanged from the original.
// Changes: takeoff schema; types live in the project's device library (key
// library_id + name, so re-saving a name updates it instead of adding a row);
// types built here are marked verified (confirmed on this drawing set), with
// detect_mode 'label' or 'shape'.
// ─────────────────────────────────────────────────────────────────

import { getAnthropic } from "./utils/clients.js";
import { requireOrg } from "./utils/auth.js";
import { td, assertWfProjectInOrg } from "./utils/takeoff-db.js";
import { meteredCreate } from "./utils/metered.js";
import { sha256, variantKey, findStored, saveStored, logReuse } from "./utils/pass-reuse.js";
import { discoverCatalog } from "../../public/lib/discover-config.js";

const MODEL = "claude-sonnet-4-5";
const CROP_PROMPT_VERSION = "discover.analyze_crop.v1";   // bump when a prompt changes

function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// Same calls as the original claudeVision / claudeText helpers, routed through
// the usage logger. `detail` names the call on the admin page.
function modelHelpers(ctx) {
  const anthropic = getAnthropic();
  return {
    async claudeVision(imageB64Array, prompt, maxTokens = 2000, detail = null) {
      const content = imageB64Array.map(b64 => ({
        type:   "image",
        source: { type: "base64", media_type: "image/jpeg", data: b64 }
      }));
      content.push({ type: "text", text: prompt });
      const resp = await meteredCreate(anthropic, {
        model: MODEL, max_tokens: maxTokens,
        messages: [{ role: "user", content }]
      }, { ...ctx, detail });
      return resp.content[0].text;
    },
    async claudeText(prompt, maxTokens = 1000, detail = null) {
      const resp = await meteredCreate(anthropic, {
        model: MODEL, max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }]
      }, { ...ctx, detail });
      return resp.content[0].text;
    },
  };
}

// ── Text anchor normalization (unchanged) ─────────────────────────
function normalizeAnchors(nearbyText) {
  if (!nearbyText || nearbyText.length === 0) return { primary: [], associated: [] };
  const primary = [], associated = [];
  nearbyText.forEach(anchor => {
    const b = anchor.replace(/[^\x20-\x7E]/g, '').trim();
    if (!b) return;
    // Numbered anchor: "DV1", "DD2", "N2" — strip digits, expand base
    if (/^[A-Z]+\d+$/.test(b)) {
      const base = b.replace(/\d+$/, '');
      primary.push(`${base}1`, `${base}2`, `${base}3`);
      associated.push(`${base}4`, `${base}5`, `${base}6`);
    // Short base code (1-2 capital letters only): "DD", "DV", "N" — expand
    } else if (/^[A-Z]{1,2}$/.test(b)) {
      primary.push(`${b}1`, `${b}2`, `${b}3`);
      associated.push(`${b}4`, `${b}5`, `${b}6`);
    // Everything else: "WAP", "CAM", "J-BOX", "FACP" — use as-is
    } else {
      primary.push(b);
    }
  });
  return { primary: [...new Set(primary)], associated: [...new Set(associated)] };
}

// ── analyze_crop (prompts unchanged) ──────────────────────────────
async function actionAnalyzeCrop(body, m) {
  const { crop_image, legend_image } = body;
  if (!crop_image) return respond(400, { error: "crop_image required" });

  // Pass 1 — describe the symbol from the crop
  const descPrompt = `This is a cropped region from a telecommunications engineering floor plan.
An estimator selected this area because it contains a device symbol they want to count.

Describe what you see:
1. The exact shape, fill, border, and size of the device symbol
2. Any text labels visible directly next to the symbol (DD2, DV1, WAP, N2, etc.)
3. What type of device this appears to be

Return ONLY valid JSON — no markdown:
{
  "visual_description": "precise description of the symbol shape and appearance",
  "nearby_text": ["DD"],
  "device_guess": "informal name e.g. data outlet, WAP, camera"
}`;

  let visual_description = "", nearby_text = [], device_guess = "";
  try {
    const raw    = await m.claudeVision([crop_image], descPrompt, 600, "describe crop");
    const parsed = parseJSON(raw);
    visual_description = parsed.visual_description || "";
    nearby_text        = parsed.nearby_text        || [];
    device_guess       = parsed.device_guess       || "";
  } catch (e) { console.warn("Crop description failed:", e.message); }

  // Pass 2 — match to legend (if legend provided)
  let legend_name = null, legend_description = "", match_confidence = "low", match_reason = "";
  if (legend_image && visual_description) {
    const matchPrompt = `The first image is a device symbol selected directly from a floor plan drawing.
The second image is the legend page for the same drawing set.

Find the legend entry that best matches this symbol.

Return ONLY valid JSON — no markdown:
{
  "legend_name": "exact name as written in legend",
  "legend_description": "description from legend",
  "match_confidence": "high|medium|low",
  "match_reason": "one sentence"
}

If no match found, set legend_name to null and match_confidence to "low".`;

    try {
      const raw    = await m.claudeVision([crop_image, legend_image], matchPrompt, 600, "legend match");
      const parsed = parseJSON(raw);
      legend_name        = parsed.legend_name        || null;
      legend_description = parsed.legend_description || "";
      match_confidence   = parsed.match_confidence   || "low";
      match_reason       = parsed.match_reason       || "";
    } catch (e) { console.warn("Legend match failed:", e.message); }
  }

  return respond(200, {
    visual_description, nearby_text, device_guess,
    legend_name, legend_description, match_confidence, match_reason
  });
}

// ── build_symbol_device ───────────────────────────────────────────
async function actionBuildSymbolDevice(body, m) {
  const { project_id, name, description, drawing_crop_base64, symbol_template, match_count } = body;

  if (!project_id)       return respond(400, { error: "project_id required" });
  if (!name)             return respond(400, { error: "name required" });
  if (!symbol_template || !Array.isArray(symbol_template.fill_rgb))
    return respond(400, { error: "symbol_template with fill_rgb required" });

  const descPrompt = `Write a visual detection description for an AI system that will find this device symbol on engineering drawings.

Device: ${name}
${description ? `Notes: ${description}` : ""}

This symbol has NO printed text label anywhere near it on the drawing — it is identified purely by its shape and fill, not by any code or abbreviation. Do not include a "TEXT NEARBY" line, or state explicitly that none exists.

Write in this exact format — be precise and calibrated to production drawing scale:

SHAPE: [geometric shape]
SIZE: [approximate size as drawn on floor plan]
FILL: [solid/outline/hatched/etc]
BORDER: [line weight and style]
INTERNAL MARKS: [internal detail or none]
TEXT NEARBY: none — identified by shape only
LOCATION: [where it typically appears — walls, ceiling, corridors, etc]
LOOK-ALIKES: [similar symbols and how to distinguish]

Return only the structured description — no preamble, no explanation.`;

  let llm_description = "";
  try { llm_description = (await m.claudeText(descPrompt, 800, `describe ${name}`)).trim(); }
  catch (e) { llm_description = "SHAPE: bare symbol, no printed label — identified by shape and fill only."; }

  const legend_id = `SYM_${name.replace(/[^A-Z0-9]/gi, "_").toUpperCase().slice(0, 30)}`;
  const detection_config = {
    type:                   name,        // explicit, decoupled from the mutable display name
    anchor:                 null,        // no text — nothing for the label track to match, kept for the
                                          // rare case a human later confirms one really does exist somewhere
    anchor_mode:            'exact',
    anchor_confidence:      'low',
    sources:                ['label', 'symbol'],
    has_symbol:             true,
    symbol_template,                     // { fill_rgb, fill_tol, body_area, single_type }
    families:               [],
    cluster_pt:             25,
    uin_pattern:            null,
    leader_from_anchor:     false,
    name_source:            'symbol_crop',
    source:                 'discovery_symbol_vector',
    validated_match_count:  match_count ?? null   // audit trail: how many hits the collision scan found at save time
  };

  const { data: dt, error: dtErr } = await m.db
    .from("device_types")
    .upsert({
      org_id:      m.orgId,
      library_id:  m.libraryId,
      created_by:  m.userId ?? null,
      detect_mode: "shape",
      verified:    true,           // built and validated on this drawing set just now
      legend_id,
      name,
      human_description:    description || "",
      llm_description,
      text_anchors:          [],
      detection_config,
      example_image_base64:  drawing_crop_base64 || null,
      updated_at:            new Date()
    }, { onConflict: "library_id,name" })
    .select("id")
    .single();

  if (dtErr) return respond(500, { error: "device_types upsert failed: " + dtErr.message });

  return respond(200, {
    device_type_id: dt.id,
    legend_id, name, llm_description, detection_config
  });
}

// ── build_device ──────────────────────────────────────────────────
async function actionBuildDevice(body, m) {
  const {
    project_id, legend_entry, all_instances = [],
    drawing_crop_base64, legend_crop_base64
  } = body;

  if (!project_id)   return respond(400, { error: "project_id required" });
  if (!legend_entry) return respond(400, { error: "legend_entry required" });

  // Aggregate text anchors from all observed instances
  const allNearbyText = [...new Set(
    all_instances.flatMap(i => i.nearby_text || [])
  )];

  // Collect visual variation notes
  const visualNotes = all_instances
    .map(i => i.visual_notes).filter(Boolean)
    .slice(0, 8).join("; ");

  const instanceCount = all_instances.length;

  const descPrompt = `Write a visual detection description for an AI system that will find this device symbol on engineering drawings.

Device: ${legend_entry.name}
Legend description: ${legend_entry.legend_description || legend_entry.short_description || "not available"}

Observed on actual floor plan drawings (${instanceCount} instance${instanceCount !== 1 ? "s" : ""} found):
${visualNotes || "Symbol appears consistent with legend reference"}

Text labels consistently found adjacent to this symbol: ${allNearbyText.join(", ") || "none observed"}

Write in this exact format — be precise and calibrated to production drawing scale:

SHAPE: [geometric shape]
SIZE: [approximate size as drawn on floor plan]
FILL: [solid/outline/hatched/etc]
BORDER: [line weight and style]
INTERNAL MARKS: [internal detail or none]
TEXT NEARBY: [text labels consistently adjacent]
LOCATION: [where it typically appears — walls, ceiling, corridors, etc]
LOOK-ALIKES: [similar symbols and how to distinguish]

Return only the structured description — no preamble, no explanation.`;

  let llm_description = "";
  try {
    llm_description = (await m.claudeText(descPrompt, 800, `describe ${legend_entry.name}`)).trim();
  } catch (e) {
    llm_description = `SHAPE: See legend\nTEXT NEARBY: ${allNearbyText.join(", ") || "none"}`;
  }

  // Normalize text anchors — prefer observed over legend
  const anchorSource = allNearbyText.length
    ? allNearbyText
    : (legend_entry.text_anchors || []);
  const text_anchors = normalizeAnchors(anchorSource);

  // ── v2 contract: derive detection_config from the observed plan instances ──
  // discoverCatalog nominates the primary anchor by frequency (the token that recurs
  // ~once per instance — N2/WAP/180) and the secondary families (DV/DD/N) from the
  // base codes around it. Per-instance nearby_text supplies that frequency signal.
  const planTokensFlat = all_instances.flatMap(i => i.nearby_text || []);   // keep dups for freq
  let detection_config = null;
  try {
    const { types } = discoverCatalog([{
      name:              legend_entry.name,
      nearby_text:       allNearbyText,
      legend_name:       legend_entry.name || null,
      legend_present:    true,                       // came from a legend entry
      approximate_count: instanceCount || null,
      has_symbol:        !!(drawing_crop_base64 || legend_crop_base64),
    }], planTokensFlat, null);
    detection_config = types[0]?.detection_config || null;
    if (detection_config) {
      detection_config.cluster_pt = 25;
      detection_config.source     = 'discovery';
      // family-bearing types (outlets) carry the 1:N leaders; standalone (WAP/180) don't
      detection_config.leader_from_anchor =
        body.leader_from_anchor != null ? !!body.leader_from_anchor
                                        : ((detection_config.families || []).length > 0);
      // optional human overrides from the review UI (fixes the N2-vs-N edge by hand)
      if (body.anchor)      { detection_config.anchor = String(body.anchor).toUpperCase(); detection_config.anchor_confidence = 'high'; }
      if (body.anchor_mode)   detection_config.anchor_mode = body.anchor_mode;
      if (body.families)      detection_config.families   = body.families.map(f => String(f).toUpperCase());
    }
  } catch (e) {
    detection_config = null;   // type still gets created; just not yet detectable
  }

  // Upsert to device_types
  const legend_id = legend_entry.id ||
    `LEG_${legend_entry.name.replace(/[^A-Z0-9]/gi, "_").toUpperCase().slice(0, 30)}`;

  const { data: dt, error: dtErr } = await m.db
    .from("device_types")
    .upsert({
      org_id:      m.orgId,
      library_id:  m.libraryId,
      created_by:  m.userId ?? null,
      detect_mode: "label",
      label_text:  detection_config?.anchor ?? null,
      verified:    true,           // confirmed from plan instances on this drawing set
      legend_id,
      name:                 legend_entry.name,
      human_description:    legend_entry.legend_description || legend_entry.short_description || "",
      llm_description,
      text_anchors,
      detection_config,
      example_image_base64: drawing_crop_base64 || legend_crop_base64 || null,
      updated_at:           new Date()
    }, { onConflict: "library_id,name" })
    .select("id")
    .single();

  if (dtErr) return respond(500, { error: "device_types upsert failed: " + dtErr.message });

  return respond(200, {
    device_type_id:  dt.id,
    legend_id,
    name:            legend_entry.name,
    instances_found: instanceCount,
    llm_description,
    text_anchors,
    detection_config
  });
}

// ── Entry point ───────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });

  let body;
  try { body = await req.json(); }
  catch { return respond(400, { error: "Invalid JSON" }); }

  const { action, project_id } = body;
  if (!action)     return respond(400, { error: "action required" });
  if (!project_id) return respond(400, { error: "project_id required" });

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  if (!(await assertWfProjectInOrg(supabase, project_id, orgId)))
    return respond(404, { error: "Project not found" });

  const db = td(supabase);
  const { data: project } = await db.from("projects").select("device_library_id").eq("id", project_id).single();
  const libraryId = project?.device_library_id ?? null;

  const ctx = { supabase, orgId, projectId: project_id, pageId: body.page_id ?? null,
                pass: `discover:${action}`, userId: user?.id };
  const m = { ...modelHelpers(ctx), db, orgId, libraryId, userId: user?.id };

  try {
    switch (action) {
      case "analyze_crop": {
        if (!body.crop_image) return respond(400, { error: "crop_image required" });
        const reuseKey = { orgId, pass: "discover:analyze_crop",
          inputHash: sha256(body.crop_image + "|" + (body.legend_image || "")),
          variant: variantKey([CROP_PROMPT_VERSION, MODEL]) };
        const stored = await findStored(supabase, reuseKey);
        if (stored) {
          await logReuse(supabase, { ...ctx, detail: null }, MODEL);
          return respond(200, { ...stored, reused: true });
        }
        const res = await actionAnalyzeCrop(body, m);
        const out = await res.json();
        // Only a complete description is stored for reuse.
        if (res.status === 200 && out.visual_description)
          await saveStored(supabase, { ...reuseKey, result: out, pageId: body.page_id ?? null });
        return respond(res.status, { ...out, reused: false });
      }
      case "build_device":
      case "build_symbol_device":
        if (!libraryId) return respond(404, { error: "This project has no device library yet" });
        return action === "build_device" ? await actionBuildDevice(body, m) : await actionBuildSymbolDevice(body, m);
      case "delete_device_type":
        return await actionDeleteDeviceType(body, m);
      default:
        return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`[wf4-discover/${action}]`, e);
    return respond(500, { error: e.message });
  }
}

// ── delete_device_type (from projects.js) ────────────────────────
async function actionDeleteDeviceType(body, m) {
  const { id, cascade } = body;
  if (!id) return respond(400, { error: "id required" });
  const { data: type } = await m.db.from("device_types").select("id")
    .eq("id", id).eq("library_id", m.libraryId ?? -1).maybeSingle();
  if (!type) return respond(404, { error: "Device type not found in this project's library" });

  const { count: instanceCount, error: countErr } = await m.db
    .from("device_instances").select("id", { count: "exact", head: true }).eq("device_type_id", id);
  if (countErr) return respond(500, { error: countErr.message });

  if ((instanceCount ?? 0) > 0 && !cascade) {
    return respond(409, { error:
      `This device has ${instanceCount} counted instance${instanceCount !== 1 ? "s" : ""} across your project. ` +
      `Deleting it will permanently remove those counts too. Confirm to delete anyway.` });
  }
  if ((instanceCount ?? 0) > 0) {
    const { error: instErr } = await m.db.from("device_instances").delete().eq("device_type_id", id);
    if (instErr) return respond(500, { error: instErr.message });
  }
  const { error } = await m.db.from("device_types").delete().eq("id", id).eq("library_id", m.libraryId);
  if (error) return respond(500, { error: error.message });
  return respond(200, { deleted: true, id, instances_deleted: instanceCount ?? 0 });
}

export const config = { path: "/api/wf/wf4/discover" };
