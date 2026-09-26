// netlify/functions/wf4-regions.js
// WF4 copy of page-regions.js — same requests and responses, `takeoff` schema.
// Regions are the schematics on a plan page (schematic | exclude | tr_room).
//
// GET    /api/wf/wf4/regions?page_id=123 | ?project_id=9
// POST   /api/wf/wf4/regions
//   create:      { project_id, page_id, label, polygon:[[x,y],...], x0,y0,x1,y1, kind? }
//   set primary: { id, demarc_id }     demarc_id = the TR pin id (old name kept)
// DELETE /api/wf/wf4/regions?id=456
//
// Responses keep the old `demarc_id` field name (stored as tr_pin_id).
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { regionToLegacy, REGION_KINDS, wfPageProject } from './utils/wf4-map.js';

const COLS = 'id, page_id, label, tr_pin_id, polygon, x0, y0, x1, y1, kind';

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

    let q = db.from('page_regions').select(COLS).eq('project_id', projectId).order('id');
    if (pageId) q = q.eq('page_id', pageId);
    const { data, error } = await q;
    if (error) return err(error.message, 500);
    return ok(data.map(regionToLegacy));
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }

    // Set-primary: link an existing region to its primary TR pin.
    if (body.id != null && body.demarc_id !== undefined) {
      const { data: region } = await db.from('page_regions').select('id, project_id').eq('id', body.id).maybeSingle();
      if (!region || !(await assertWfProjectInOrg(supabase, region.project_id, orgId))) return err('Region not found', 404);
      if (body.demarc_id != null) {
        const { data: pin } = await db.from('tr_pins').select('project_id').eq('id', body.demarc_id).maybeSingle();
        if (!pin || String(pin.project_id) !== String(region.project_id)) return err('TR pin not found in this project', 404);
      }
      const { data, error } = await db.from('page_regions')
        .update({ tr_pin_id: body.demarc_id ?? null })
        .eq('id', body.id)
        .select('id, page_id, label, tr_pin_id')
        .single();
      if (error) return err(error.message, 500);
      return ok(regionToLegacy(data));
    }

    const { project_id, page_id, label, polygon, x0, y0, x1, y1, kind } = body;
    if (!project_id || !page_id || !Array.isArray(polygon) || !polygon.length)
      return err('project_id, page_id and polygon required');
    const pageProject = await wfPageProject(supabase, page_id, orgId);
    if (!pageProject || String(pageProject) !== String(project_id)) return err('Page not found in this project', 404);

    const row = {
      org_id: orgId,
      project_id, page_id,
      label: label ?? null,
      polygon,
      x0: x0 ?? null, y0: y0 ?? null, x1: x1 ?? null, y1: y1 ?? null,
      kind: REGION_KINDS.includes(kind) ? kind : 'schematic',
    };
    const { data, error } = await db.from('page_regions').insert(row).select(COLS).single();
    if (error) return err(error.message, 500);
    return ok(regionToLegacy(data));
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return err('id required');
    const { data: region, error: findErr } = await db.from('page_regions').select('id, project_id').eq('id', id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!region) return err('Region not found', 404);
    if (!(await assertWfProjectInOrg(supabase, region.project_id, orgId))) return err('Project not found', 404);

    const { error } = await db.from('page_regions').delete().eq('id', id);
    if (error) return err(error.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err('Method not allowed', 405);
}

export const config = { path: '/api/wf/wf4/regions' };
