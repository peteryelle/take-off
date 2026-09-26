// netlify/functions/wf4-wall-geometry.js
// WF4 copy of pass-wall-geometry.js — persists ONE page's classified
// wall/door/tray geometry, computed in the browser (classifyGeometry from
// wall-calibration.js) against the confirmed project signature. The WF4 batch
// reads it for Routed mode; no PDF is opened on the server. Free — no metered calls.
//
// Called once per page right after the wall calibration is confirmed — not on
// every batch run (the geometry doesn't change between runs, only the routes).
//
// POST /api/wf/wf4/wall-geometry   { page_id, project_id, walls, doors, tray? }
// GET  /api/wf/wf4/wall-geometry?page_id=123   -> geometry, or null if not yet
//      extracted (the batch then routes that page without walls).
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { wfPageProject } from './utils/wf4-map.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const pageId = new URL(req.url).searchParams.get('page_id');
    if (!pageId) return err('page_id required');
    if (!(await wfPageProject(supabase, pageId, orgId))) return err('Page not found', 404);
    const { data, error } = await db.from('page_wall_geometry').select('*').eq('page_id', pageId).maybeSingle();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  if (req.method !== 'POST') return err('Method not allowed', 405);
  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }
  const { page_id, project_id, walls, doors, tray } = body;
  if (!page_id || !project_id) return err('page_id and project_id required');
  if (!Array.isArray(walls)) return err('walls array required (even if empty)');
  if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);
  const pageProject = await wfPageProject(supabase, page_id, orgId);
  if (!pageProject || String(pageProject) !== String(project_id)) return err('Page not found in this project', 404);

  const { data: calib } = await db.from('wall_calibrations').select('id').eq('project_id', project_id).maybeSingle();

  const { data, error } = await db.from('page_wall_geometry').upsert({
    org_id: orgId, page_id, project_id,
    wall_calibration_id: calib?.id ?? null,
    walls, doors: doors ?? [], tray: tray ?? [],
    extracted_at: new Date().toISOString(),
  }, { onConflict: 'page_id' }).select('*').single();
  if (error) return err(error.message, 500);
  return ok(data);
}

export const config = { path: '/api/wf/wf4/wall-geometry' };
