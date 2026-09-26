// netlify/functions/wf4-pins.js
// WF4 copy of pass-demarc.js — demarcs are stored as takeoff.tr_pins.
// Requests and responses keep the old demarc shape, so the ported UI and the
// batch/routing code need no changes to how they read a pin.
//
// GET    /api/wf/wf4/pins?page_id=123 | ?project_id=9
// POST   /api/wf/wf4/pins
//   { project_id, page_id|null, name, source: 'auto'|'user_pin'|'off_sheet',
//     x_norm, y_norm, stub_ft, region_id, note, tr_id? }
// DELETE /api/wf/wf4/pins?id=456   (refused while devices or regions use it)
//
// Dedup is unchanged from the old function: a pin's identity is what it IS,
// not the typed name — an exit pin is one per page; a serving pin is one per
// page + schematic region. Off-sheet pins (no page) always insert.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { demarcBodyToPinRow, pinToDemarc, pinKind, wfPageProject } from './utils/wf4-map.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const pageId = url.searchParams.get('page_id');
    const projId = url.searchParams.get('project_id');
    if (!pageId && !projId) return err('page_id or project_id required');
    const projectId = projId || (await wfPageProject(supabase, pageId, orgId));
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);

    let q = db.from('tr_pins').select('*').eq('project_id', projectId).order('entered_at');
    if (pageId) q = q.eq('page_id', pageId);
    const { data, error } = await q;
    if (error) return err(error.message, 500);
    return ok(data.map(pinToDemarc));
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }

    const { project_id, page_id, name, source, region_id } = body;
    if (!project_id || !name || !source) return err('project_id, name and source required');
    if (!['auto', 'user_pin', 'off_sheet'].includes(source)) return err('source must be auto, user_pin or off_sheet');
    if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);
    // page_id is legitimately null for an off-sheet pin — only check it when given.
    if (page_id != null) {
      const pageProject = await wfPageProject(supabase, page_id, orgId);
      if (!pageProject || String(pageProject) !== String(project_id)) return err('Page not found in this project', 404);
    }
    if (source !== 'off_sheet' && (body.x_norm == null || body.y_norm == null))
      return err('x_norm and y_norm required for a pin on a sheet');

    const row = demarcBodyToPinRow(body, { orgId, userId: user.id });

    let existingId = null;
    if (page_id != null) {
      const kind = pinKind(source, name);
      let find = db.from('tr_pins').select('id').eq('project_id', project_id).eq('page_id', page_id).eq('pin_kind', kind);
      if (kind === 'serving') find = region_id != null ? find.eq('region_id', region_id) : find.is('region_id', null);
      const { data: existing, error: findErr } = await find.limit(1).maybeSingle();
      if (findErr) return err(findErr.message, 500);
      if (existing) existingId = existing.id;
    }

    const { data, error } = existingId
      ? await db.from('tr_pins').update(row).eq('id', existingId).select('*').single()
      : await db.from('tr_pins').insert(row).select('*').single();
    if (error) return err(error.message, 500);
    return ok(pinToDemarc(data));
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return err('id required');
    const { data: pin, error: findErr } = await db.from('tr_pins').select('id, project_id, tr_name').eq('id', id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!pin) return err('TR pin not found', 404);
    if (!(await assertWfProjectInOrg(supabase, pin.project_id, orgId))) return err('Project not found', 404);

    const [{ count: deviceRefs, error: dErr }, { count: regionRefs, error: rErr }] = await Promise.all([
      db.from('device_instances').select('id', { count: 'exact', head: true }).eq('tr_pin_id', id),
      db.from('page_regions').select('id', { count: 'exact', head: true }).eq('tr_pin_id', id),
    ]);
    if (dErr) return err(dErr.message, 500);
    if (rErr) return err(rErr.message, 500);
    if ((deviceRefs ?? 0) > 0 || (regionRefs ?? 0) > 0) {
      return err(
        `Cannot delete "${pin.tr_name}" — ${deviceRefs ?? 0} device(s) and ` +
        `${regionRefs ?? 0} schematic(s) still reference it. Repoint or clear those first.`,
        409
      );
    }
    const { error } = await db.from('tr_pins').delete().eq('id', id);
    if (error) return err(error.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err('Method not allowed', 405);
}

export const config = { path: '/api/wf/wf4/pins' };
