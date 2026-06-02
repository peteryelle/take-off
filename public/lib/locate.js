// locate.js — the symbol LOCATOR router (substep 5). Vector-first, probe-driven.
// For each symbol-detector group it decides HOW to locate glyphs:
//   - VECTOR  : deterministic geometry (the adapter) when the sheet is vector
//               (sheet_class.vector_geometry) AND the group carries a symbol_template
//               (fill + prototypes). No LLM budget, exact centroids.
//   - LLM     : the pass-symbol strip locator otherwise — raster sheets, or types with
//               only a text description. This is the documented fallback, and it is also
//               the per-type DEGRADE: a vector group that finds nothing reverts here.
// raster_only and "no template" both route to LLM, so existing behaviour is preserved
// until a type is given a vector template — the vector path only ever ADDS capability.
//
// Pure routing + instance assembly here; the actual vector extraction is delegated to
// the injected geometry adapter (which has pdf.js injected upstream), so this module
// imports no PDF library. Output is the live contract { type, x, y, confidence } that
// pass-extract already threads into reconcile — plus flag/via for the review surface.

import { classifyCameraBlob } from './geometry.js';

const fillKey = (rgb) => (Array.isArray(rgb) ? rgb.join(',') : 'none');
const hasTemplate = (g) => !!(g && Array.isArray(g.prototypes) && g.prototypes.length && Array.isArray(g.fill_rgb));

/**
 * Decide the locate route for one symbol group on one sheet. Pure.
 * @param {Object} sheetClass  { vector_text, vector_geometry, raster_only } (or null)
 * @param {Object} group       { fill_rgb?, prototypes?, ... }
 * @returns {'vector'|'llm'}
 */
export function chooseLocator(sheetClass, group) {
  if (sheetClass && sheetClass.vector_geometry && hasTemplate(group)) return 'vector';
  return 'llm'; // raster, or no vector template -> the pass-symbol fallback
}

/**
 * Turn located vector blobs into the symbol_instances reconcile consumes. Each blob is
 * classified against the group's prototypes (or the validated camera rule when none),
 * and the prototype's `type` IS the catalog type string reconcile joins on. A glyph that
 * matches no prototype is surfaced as { type:null, flag:'no_match' } — never coerced.
 * @param {Array}  blobs  from groupSubpaths/extractCameraBlobs (carry x,y normalized)
 * @param {Object} group  { prototypes?, proto_tol?, aspect_hub_max? }
 * @returns {Array} [{ type, x, y, confidence, flag, via:'vector' }]
 */
export function blobsToInstances(blobs = [], group = {}) {
  const opts = { prototypes: group.prototypes || null, protoTol: group.proto_tol ?? 1.4, aspectHubMax: group.aspect_hub_max ?? 2.2 };
  return blobs.map((b) => {
    const r = classifyCameraBlob(b, opts);
    return { type: r.type, x: b.x, y: b.y, confidence: r.confidence, flag: r.flag || (r.type === null ? 'no_match' : null), via: 'vector' };
  });
}

/**
 * Plan symbol detection across a sheet's symbol-sourced device types. Groups vector-
 * capable types that share a fill template so their glyphs are located ONCE and split
 * by prototype (the QTS camera case: 3 lens-class types, one red fill, one locate pass).
 * Types without a template each get an LLM route (today's per-type pass-symbol behaviour).
 * Pure — returns a plan the impure client executes.
 *
 * @param {Object} sheetClass
 * @param {Array}  symTypes  [{ id, name, detection_config }] (sources includes 'symbol')
 * @returns {Array} steps:
 *   vector: { route:'vector', group:{fill_rgb,fill_tol,body_area,prototypes,...}, device_type_ids:[...] }
 *   llm:    { route:'llm', device_type_id, name }
 */
export function planSymbolDetection(sheetClass, symTypes = []) {
  const vectorGroups = new Map(); // fillKey -> { group, device_type_ids }
  const steps = [];
  for (const dt of symTypes) {
    const cfg = dt.detection_config || {};
    const tmpl = cfg.symbol_template || null;
    const group = tmpl && Array.isArray(tmpl.prototypes)
      ? { fill_rgb: tmpl.fill_rgb, fill_tol: tmpl.fill_tol ?? 48, body_area: tmpl.body_area ?? 2e-5, prototypes: tmpl.prototypes, proto_tol: tmpl.proto_tol, aspect_hub_max: tmpl.aspect_hub_max }
      : null;
    if (chooseLocator(sheetClass, group) === 'vector') {
      const k = fillKey(group.fill_rgb);
      if (!vectorGroups.has(k)) {
        const step = { route: 'vector', group, device_type_ids: [] };
        vectorGroups.set(k, step);
        steps.push(step);
      }
      vectorGroups.get(k).device_type_ids.push(dt.id);
    } else {
      steps.push({ route: 'llm', device_type_id: dt.id, name: dt.name });
    }
  }
  return steps;
}

/**
 * Execute a vector locate for one group (impure: needs the page; geometry adapter
 * injected so no PDF import here). Defensive degrade: zero blobs -> degraded:true so
 * the caller can fall back to the LLM locator for this group.
 * @param {Object} page, @param {Object} OPS, @param {Array} textCenters
 * @param {Object} group, @param {Object} deps { extractCameraBlobs }, @param {Object} opts { vpW, vpH }
 * @returns {Promise<{ instances, blob_count, degraded }>}
 */
export async function locateVector(page, OPS, textCenters, group, deps = {}, opts = {}) {
  const { extractCameraBlobs } = deps;
  const { blobs } = await extractCameraBlobs(page, OPS, textCenters, {
    vpW: opts.vpW, vpH: opts.vpH, fill: group.fill_rgb, fillTol: group.fill_tol ?? 48, bodyArea: group.body_area ?? 2e-5,
  });
  return { instances: blobsToInstances(blobs, group), blob_count: blobs.length, degraded: blobs.length === 0 };
}

export default { chooseLocator, blobsToInstances, planSymbolDetection, locateVector };
