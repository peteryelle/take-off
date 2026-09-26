// netlify/functions/wf4-waypoints.js
// WF4 copy of pass-waypoint.js — Routed-mode point waypoints
// (public/lib/waypoint-path.js chains them into a routed distance).
//
// GET    /api/wf/wf4/waypoints?page_id=123 | ?project_id=9
// POST   /api/wf/wf4/waypoints   { project_id, page_id, x_norm, y_norm, label? }
// DELETE /api/wf/wf4/waypoints?id=456
//
// Delete is unguarded, as before: nothing stores a reference to a waypoint —
// paths are recomputed from the live set at every run.
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
    const url = new URL(req.url);
    const pageId = url.searchParams.get('page_id');
    const projId = url.searchParams.get('project_id');
    if (!pageId && !projId) return err('page_id or project_id required');
    const projectId = projId || (await wfPageProject(supabase, pageId, orgId));
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    let q = db.from('waypoints').select('*').eq('project_id', projectId).order('created_at');
    if (pageId) q = q.eq('page_id', pageId);
    const { data, error } = await q;
    if (error) return err(error.message, 500);
    return ok(data);
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    const { project_id, page_id, x_norm, y_norm, label } = body;
    if (!project_id || !page_id) return err('project_id and page_id required');
    if (!Number.isFinite(x_norm) || !Number.isFinite(y_norm)) return err('x_norm and y_norm required');
    if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);
    const pageProject = await wfPageProject(supabase, page_id, orgId);
    if (!pageProject || String(pageProject) !== String(project_id)) return err('Page not found in this project', 404);

    const { data, error } = await db.from('waypoints')
      .insert({ org_id: orgId, project_id, page_id, x_norm, y_norm, label: label ?? null })
      .select('*').single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return err('id required');
    const { data: wp, error: findErr } = await db.from('waypoints').select('id, project_id').eq('id', id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!wp) return err('Waypoint not found', 404);
    if (!(await assertWfProjectInOrg(supabase, wp.project_id, orgId))) return err('Project not found', 404);
    const { error } = await db.from('waypoints').delete().eq('id', id);
    if (error) return err(error.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err('Method not allowed', 405);
}

export const config = { path: '/api/wf/wf4/waypoints' };
