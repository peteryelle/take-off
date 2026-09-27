// netlify/functions/wf5-rooms.js
// WF5 TR rooms — manual entry. Free (no model calls).
//
// GET  /api/wf/wf5/rooms?project_id=9
//   -> { trs:[{id,tr_number}], values:[{tr_name,category,quantity,source,page_id,override_basis,entered_at}],
//        marks:[{tr_name,page_id,x_norm,y_norm,marked_at}] }
// POST /api/wf/wf5/rooms
//   { action:'save', project_id, cells:[{tr_name, category, quantity|null, page_id?, basis?}] }
//      quantity null deletes the cell; others upsert on (project_id, tr_name, category)
//      as source 'manual' with override_basis = basis || default.
//   { action:'mark',   project_id, tr_name, page_id, x_norm, y_norm }   stamp "done"
//   { action:'unmark', project_id, tr_name }
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { validateCells } from '../../public/lib/wf5-rows.js';

const DEFAULT_BASIS = 'Entered by hand from the TR room plans';

async function projectTrs(db, projectId) {
  const { data, error } = await db.from('trs').select('id, tr_number').eq('project_id', projectId).order('tr_number');
  if (error) throw new Error(error.message);
  return (data || []).filter((t) => t.tr_number);
}

async function pagesInProject(db, projectId, ids) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  if (!want.length) return new Set();
  const { data, error } = await db.from('pages').select('id').eq('project_id', projectId).in('id', want);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((p) => p.id));
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  try {
    if (req.method === 'GET') {
      const projectId = new URL(req.url).searchParams.get('project_id');
      if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
      const [trs, values, marks] = await Promise.all([
        projectTrs(db, projectId),
        db.from('tr_room_devices').select('tr_name, category, quantity, source, page_id, override_basis, entered_at').eq('project_id', projectId),
        db.from('tr_room_marks').select('tr_name, page_id, x_norm, y_norm, marked_at').eq('project_id', projectId),
      ]);
      if (values.error) return err(values.error.message, 500);
      if (marks.error) return err(marks.error.message, 500);
      return ok({ trs, values: values.data || [], marks: marks.data || [] });
    }

    if (req.method !== 'POST') return err('Method not allowed', 405);
    let b;
    try { b = await req.json(); } catch { return err('Invalid JSON'); }
    if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
    const trs = await projectTrs(db, b.project_id);
    const trId = new Map(trs.map((t) => [t.tr_number, t.id]));

    if (b.action === 'save') {
      const { cells, errors } = validateCells(b.cells, trs.map((t) => t.tr_number));
      if (errors.length) return err(errors.slice(0, 5).join('; '));
      const okPages = await pagesInProject(db, b.project_id, cells.map((c) => c.page_id));

      const del = cells.filter((c) => c.quantity == null);
      const up = cells.filter((c) => c.quantity != null).map((c) => ({
        org_id: orgId, project_id: b.project_id, tr_name: c.tr_name, tr_id: trId.get(c.tr_name) ?? null,
        category: c.category, quantity: c.quantity, source: 'manual',
        page_id: okPages.has(Number(c.page_id)) ? Number(c.page_id) : null,
        override_basis: String(c.basis || '').trim() || DEFAULT_BASIS,
        original_value: null, conflict: null, entered_by: user.id, entered_at: new Date().toISOString(),
      }));

      if (up.length) {
        const { error } = await db.from('tr_room_devices').upsert(up, { onConflict: 'project_id,tr_name,category' });
        if (error) return err(error.message, 500);
      }
      let deleted = 0;
      for (const c of del) {
        const { data, error } = await db.from('tr_room_devices').delete()
          .eq('project_id', b.project_id).eq('tr_name', c.tr_name).eq('category', c.category).select('id');
        if (error) return err(error.message, 500);
        deleted += (data || []).length;
      }
      return ok({ saved: up.length, deleted });
    }

    if (b.action === 'mark') {
      if (!trId.has(b.tr_name)) return err(`Unknown TR "${b.tr_name}"`);
      const x = Number(b.x_norm), y = Number(b.y_norm);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return err('x_norm and y_norm must be between 0 and 1');
      const okPages = await pagesInProject(db, b.project_id, [b.page_id]);
      if (!okPages.has(Number(b.page_id))) return err('Page not found in this project', 404);
      const { data, error } = await db.from('tr_room_marks').upsert({
        org_id: orgId, project_id: b.project_id, tr_name: b.tr_name, page_id: Number(b.page_id),
        x_norm: x, y_norm: y, marked_by: user.id, marked_at: new Date().toISOString(),
      }, { onConflict: 'project_id,tr_name' }).select('tr_name, page_id, x_norm, y_norm, marked_at').single();
      if (error) return err(error.message, 500);
      return ok(data);
    }

    if (b.action === 'unmark') {
      const { error } = await db.from('tr_room_marks').delete().eq('project_id', b.project_id).eq('tr_name', b.tr_name);
      if (error) return err(error.message, 500);
      return ok({ unmarked: b.tr_name });
    }

    return err('Unknown action');
  } catch (e) {
    return err(e.message, 500);
  }
}

export const config = { path: '/api/wf/wf5/rooms' };
