// public/lib/wall-calibration-client.js
//
// Client-side orchestration for wall-signature calibration and geometry
// persistence. Runs in the browser against real pdf.js page objects — same
// pattern extractFilledSubpaths already uses for camera detection (see
// multi-page.html's `V.deriveSheetClassSignals(pdfPage, pdfjsLib.OPS, ...)`
// call). Every /api/* fetch here goes through auth.js's global fetch
// interceptor automatically (confirmed on a live network trace: pass-b-page
// returns 200 with an Authorization header stamped by auth.js, initiator
// `window.fetch -> auth.js:58`) — nothing here needs to touch tokens.
//
// Four things this module does, matching the design worked out over this
// project's wall-calibration/wall-aware-path build:
//   1. runWallCalibration    — score every page, aggregate, POST a 'suggested' row
//   2. renderCalibrationPreview — draw the winning signature's walls/doors on
//      a canvas overlay, so a human confirms by looking at real geometry on
//      the real page, not a confidence number (same principle as the
//      exclude-zone modal's visual-verification pattern)
//   3. confirmWallCalibration / rejectWallCalibration / tryNextCandidate —
//      thin wrappers over pass-wall-calibrate.js's three actions
//   4. persistAllPageGeometry — AFTER confirm, run classifyGeometry against
//      every page and POST each result to pass-wall-geometry.js. This is the
//      step that makes pass-batch.js's buildPageRouter reachable server-side
//      without ever loading a PDF there — see that endpoint's own docstring.

import { extractStrokeSubpaths } from "./geometry.js";
import { scorePage, aggregateScores, classifyGeometry } from "./wall-calibration.js";

/**
 * @typedef {{ pageNum: number, pageId: number, pdfPage: Object }} PageEntry
 * pdfPage is a pdf.js page object (from pdfDoc.getPage(pageNum)), same shape
 * multi-page.html already has in hand for rendering.
 */

/**
 * Score every page, aggregate, and POST a new 'suggested' calibration row.
 * Does NOT persist wall/door geometry — that's persistAllPageGeometry,
 * deliberately deferred until after a human confirms the signature.
 *
 * @param {{ apiBase: string, projectId: number, pages: PageEntry[], OPS: Object }} args
 * @returns {Promise<Object>} the wall_calibrations row (status: 'suggested')
 */
export async function runWallCalibration({ apiBase, projectId, pages, OPS }) {
  if (!pages.length) throw new Error("No pages to calibrate against.");

  const perPage = [];
  for (const { pageId, pdfPage } of pages) {
    const strokes = await extractStrokeSubpaths(pdfPage, OPS);
    const scores = await scorePage(strokes, pdfPage);
    perPage.push({ pageId, scores });
  }

  const candidates = aggregateScores(perPage);
  if (!candidates.length) {
    throw new Error("No candidate wall geometry found on any page — this project may need waypoint routing instead.");
  }

  const res = await fetch(`${apiBase}/api/pass-wall-calibrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      candidates: candidates.map((c) => ({ color: c.color, width: c.width, score: c.score })),
      pages_evaluated: pages.length,
      pages_agreeing: candidates[0].pagesAgreeing,
      preview_page_id: pages[0].pageId,
    }),
  });
  if (!res.ok) throw new Error(`pass-wall-calibrate failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Draw the given signature's classified walls (red lines) and doors (yellow
 * dots) onto an already-rendered canvas, at the same scale the page itself
 * was rendered at. classifyGeometry's output is already y-down (top-left
 * origin) — the same orientation canvas natively uses — so this is a direct
 * scale multiply, no further flip needed.
 *
 * @param {{ canvas: HTMLCanvasElement, pdfPage: Object, OPS: Object,
 *   signature: {color:number[], width:number}, viewportScale: number }} args
 * @returns {Promise<{wallCount:number, doorCount:number, walls:Array, doors:Array}>}
 */
export async function renderCalibrationPreview({ canvas, pdfPage, OPS, signature, viewportScale }) {
  const strokes = await extractStrokeSubpaths(pdfPage, OPS);
  const { walls, doors } = await classifyGeometry(strokes, pdfPage, signature);

  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.strokeStyle = "#ff3b3b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of walls) {
    ctx.moveTo(x1 * viewportScale, y1 * viewportScale);
    ctx.lineTo(x2 * viewportScale, y2 * viewportScale);
  }
  ctx.stroke();

  ctx.fillStyle = "#f2c14e";
  for (const d of doors) {
    ctx.beginPath();
    ctx.arc(d.x * viewportScale, d.y * viewportScale, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  return { wallCount: walls.length, doorCount: doors.length, walls, doors };
}

/** Confirm the current suggested signature. Enables Tier 3 for this project
 * once persistAllPageGeometry has also run (confirming alone doesn't persist
 * geometry — see that function). */
export async function confirmWallCalibration({ apiBase, projectId }) {
  const res = await fetch(`${apiBase}/api/pass-wall-calibrate/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(`confirm failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Reject the current suggestion. Project stays on Tier 1 waypoint routing.
 * If a prior calibration was 'confirmed', flags every device routed under it
 * as wall_calibration_stale server-side — see pass-wall-calibrate.js. */
export async function rejectWallCalibration({ apiBase, projectId }) {
  const res = await fetch(`${apiBase}/api/pass-wall-calibrate/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(`reject failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Advance to the next-ranked candidate signature without rescoring. Returns
 * the updated row (status back to 'suggested') so the caller can re-render
 * the preview against the new signature and ask for confirmation again. */
export async function tryNextCandidate({ apiBase, projectId }) {
  const res = await fetch(`${apiBase}/api/pass-wall-calibrate/try-next`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(`try-next failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Run AFTER confirm: classify every page against the confirmed signature and
 * persist the result via pass-wall-geometry.js. This is what actually makes
 * Tier 3 routing usable — pass-batch.js reads this persisted geometry, never
 * loading a PDF itself. Runs pages sequentially (not Promise.all) so a
 * single slow/failing page doesn't spike memory across a whole project at
 * once; large projects will just take proportionally longer, not fail.
 *
 * @param {{ apiBase: string, projectId: number, pages: PageEntry[], OPS: Object,
 *   signature: {color:number[], width:number} }} args
 * @returns {Promise<Array<{pageNum, pageId, ok, status, wallCount, doorCount}>>}
 */
export async function persistAllPageGeometry({ apiBase, projectId, pages, OPS, signature }) {
  const results = [];
  for (const { pageNum, pageId, pdfPage } of pages) {
    try {
      const strokes = await extractStrokeSubpaths(pdfPage, OPS);
      const { walls, doors } = await classifyGeometry(strokes, pdfPage, signature);
      const res = await fetch(`${apiBase}/api/pass-wall-geometry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId, project_id: projectId, walls, doors }),
      });
      results.push({
        pageNum, pageId, ok: res.ok, status: res.status,
        wallCount: walls.length, doorCount: doors.length,
      });
    } catch (e) {
      results.push({ pageNum, pageId, ok: false, status: null, error: e.message });
    }
  }
  return results;
}
