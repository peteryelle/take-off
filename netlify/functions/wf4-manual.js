// netlify/functions/wf4-manual.js
// WF4 copy of manual-device.js — a device a person adds on the confidence map
// when detection missed it. Stored as a takeoff.device_instances row with
// source = 'manual' (and a required override_basis), not a separate table.
//
// GET    /api/wf/wf4/manual?page_id=123
// POST   /api/wf/wf4/manual   { project_id, page_id, device_type_id, x_norm, y_norm, uin?, override_basis? }
// DELETE /api/wf/wf4/manual?id=456   (undo a mis-click; manual rows only)
//
// Survival across re-runs: the old batch re-injected manual_devices rows each
// run and wiped device_instances per page. The WF4 batch copy wipes only
// source <> 'manual' rows and re-injects these, so manual adds still survive.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { manualBodyToInstanceRow, instanceToManual, wfPageProject } from './utils/wf4-map.js';

const COLS = 'id, page_id, device_type_id, x_norm, y_norm, uin, entered_at';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const pageId = new URL(req.url).searchParams.get('page_id');
    if (!pageId) return err('page_id required');
    if (!(await wfPageProject(supabase, pageId, orgId))) return err('Page not found', 404);
    const { data, error } = await db.from('device_instances').select(COLS)
      .eq('page_id', pageId).eq('source', 'manual').order('id');
    if (error) return err(error.message, 500);
    return ok(data.map(instanceToManual));
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    const { project_id, page_id, device_type_id, x_norm, y_norm } = body;
    if (!project_id || !page_id || !device_type_id || x_norm == null || y_norm == null)
      return err('project_id, page_id, device_type_id, x_norm, y_norm required');
    if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);
    const pageProject = await wfPageProject(supabase, page_id, orgId);
    if (!pageProject || String(pageProject) !== String(project_id)) return err('Page not found in this project', 404);
    const { data: dt } = await db.from('device_types').select('id').eq('id', device_type_id).eq('org_id', orgId).maybeSingle();
    if (!dt) return err('Device type not found', 404);

    const { data, error } = await db.from('device_instances')
      .insert(manualBodyToInstanceRow(body, { orgId, userId: user.id }))
      .select(COLS).single();
    if (error) return err(error.message, 500);
    return ok(instanceToManual(data));
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return err('id required');
    const { data: row, error: findErr } = await db.from('device_instances')
      .select('id, project_id, source').eq('id', id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!row || row.source !== 'manual') return err('Manual device not found', 404);
    if (!(await assertWfProjectInOrg(supabase, row.project_id, orgId))) return err('Project not found', 404);

    const { error } = await db.from('device_instances').delete().eq('id', id).eq('source', 'manual');
    if (error) return err(error.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err('Method not allowed', 405);
}

export const config = { path: '/api/wf/wf4/manual' };
