// netlify/functions/wf4-settings.js
// WF4 cable-length settings. Free — no metered calls.
//
// POST /api/wf/wf4/settings
//   project: { project_id, route_mode?, straight_multiplier?, right_angle_multiplier?, routed_multiplier? }
//   sheet:   { project_id, page_id, route_mode: mode|null, route_multiplier: n|null }   null = use the project's
//
// After saving, stored device lengths are brought up to date where that needs
// no re-measuring (public/lib/route-modes.js planSettingsChange):
//   * multiplier changed, same mode -> route_ft = raw x new multiplier + TR stub
//     (in place, so devices excluded on the map stay excluded);
//   * mode changed -> the geometry must be re-measured: those sheets are
//     returned in `recount_pages` and the page asks for a re-count (free).
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { ROUTE_MODES, planSettingsChange } from '../../public/lib/route-modes.js';
import { resolveTiaLimit } from '../../public/lib/pipeline-guards.js';

const TIA_OUTLET_FT = 295;   // same default as the batch

const MULT_KEYS = ['straight_multiplier', 'right_angle_multiplier', 'routed_multiplier'];
const validMult = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 5;

async function fetchAll(query, pageSize = 1000) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await query().order('id').range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) return all;
    from += pageSize;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'POST') return err('POST required', 405);
  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }
  const { project_id, page_id } = body;
  if (!project_id) return err('project_id required');

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;
  const db = td(supabase);
  if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);

  try {
    if (page_id != null) {
      // ── one sheet's override ──
      const { data: page } = await db.from('pages').select('id, project_id').eq('id', page_id).maybeSingle();
      if (!page || String(page.project_id) !== String(project_id)) return err('Page not found in this project', 404);
      const upd = {};
      if ('route_mode' in body) {
        if (body.route_mode != null && !ROUTE_MODES.includes(body.route_mode)) return err('route_mode must be straight, right_angle, routed or null');
        upd.route_mode = body.route_mode ?? null;
      }
      if ('route_multiplier' in body) {
        if (body.route_multiplier != null && !validMult(body.route_multiplier)) return err('route_multiplier must be a number above 0 (at most 5), or null');
        upd.route_multiplier = body.route_multiplier == null ? null : Number(body.route_multiplier);
      }
      if (!Object.keys(upd).length) return err('route_mode or route_multiplier required');
      const { error } = await db.from('pages').update(upd).eq('id', page_id);
      if (error) return err(error.message, 500);
    } else {
      // ── project settings ──
      const upd = {};
      if ('route_mode' in body) {
        if (!ROUTE_MODES.includes(body.route_mode)) return err('route_mode must be straight, right_angle or routed');
        upd.route_mode = body.route_mode;
      }
      for (const k of MULT_KEYS) if (k in body) {
        if (!validMult(body[k])) return err(`${k} must be a number above 0 (at most 5)`);
        upd[k] = Number(body[k]);
      }
      if (!Object.keys(upd).length) return err('nothing to change');
      const { error } = await db.from('projects').update(upd).eq('id', project_id);
      if (error) return err(error.message, 500);
    }

    // ── bring stored lengths up to date ──
    const [{ data: project }, pages, pins, devices] = await Promise.all([
      db.from('projects').select('route_mode, straight_multiplier, right_angle_multiplier, routed_multiplier, device_library_id').eq('id', project_id).single(),
      fetchAll(() => db.from('pages').select('id, route_mode, route_multiplier').eq('project_id', project_id)),
      fetchAll(() => db.from('tr_pins').select('id, stub_ft').eq('project_id', project_id)),
      fetchAll(() => db.from('device_instances')
        .select('id, page_id, device_type_id, route_method, route_ft_raw, route_multiplier, tr_pin_id')
        .eq('project_id', project_id).not('route_method', 'is', null)),
    ]);
    const types = project.device_library_id
      ? await fetchAll(() => db.from('device_types').select('id, tia_limit_ft').eq('library_id', project.device_library_id))
      : [];
    const limitByType = new Map(types.map((t) => [String(t.id), resolveTiaLimit(t.tia_limit_ft, TIA_OUTLET_FT)]));
    const plan = planSettingsChange(project, pages, devices, new Map(pins.map((p) => [String(p.id), p.stub_ft])),
      (d) => limitByType.get(String(d.device_type_id)) ?? TIA_OUTLET_FT);

    // One UPDATE per distinct (route_ft, multiplier) pair keeps the call count
    // small without an upsert (which would need every NOT NULL column).
    const groups = new Map();
    for (const r of plan.rescale) {
      const k = `${r.route_ft}|${r.route_multiplier}|${r.tia_reason ?? ''}`;
      if (!groups.has(k)) groups.set(k, { route_ft: r.route_ft, route_multiplier: r.route_multiplier, tia_flag: r.tia_flag, tia_reason: r.tia_reason, ids: [] });
      groups.get(k).ids.push(r.id);
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.ids.length; i += 500) {
        const { error } = await db.from('device_instances')
          .update({ route_ft: g.route_ft, route_multiplier: g.route_multiplier, tia_flag: g.tia_flag, tia_reason: g.tia_reason })
          .in('id', g.ids.slice(i, i + 500));
        if (error) return err(`Length update failed: ${error.message}`, 500);
      }
    }
    return ok({ saved: true, rescaled: plan.rescale.length, recount_pages: plan.recount_pages });
  } catch (e) {
    return err(e.message, 500);
  }
}

export const config = { path: '/api/wf/wf4/settings' };
