// netlify/functions/wf4-wall-calibrate.js
// WF4 copy of pass-wall-calibrate.js — project-level wall-signature
// calibration for Routed mode. CRUD only: scoring runs in the browser
// (wall-calibration.js scorePage/aggregateScores on pdf.js pages — free);
// this endpoint stores the client's ranked candidates and their status.
// Wall-aware routing is used only while status = 'confirmed'.
//
// GET  /api/wf/wf4/wall-calibrate?project_id=123   current calibration or null
// POST /api/wf/wf4/wall-calibrate
//   { project_id, candidates:[{color,width,score},...], pages_evaluated, pages_agreeing, preview_page_id }
//   { project_id, action: 'confirm' | 'reject' | 'try-next' }
//
// One change from the old function: on reject of a confirmed calibration,
// only devices whose route_method = 'routed' are flagged
// wall_calibration_stale — straight-line and right-angle lengths never used
// the wall signature, so they are not stale.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const projectId = new URL(req.url).searchParams.get('project_id');
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    const { data, error } = await db.from('wall_calibrations').select('*').eq('project_id', projectId).maybeSingle();
    if (error) return err(error.message, 500);
    return ok(data);
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }
  const { project_id, action } = body;
  if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);

  const logRun = (outcome, c) =>
    db.from('wall_calibration_runs').insert({
      org_id: orgId, project_id, outcome,
      score: c.score, runner_up_score: c.runner_up_score,
      pages_agreeing: c.pages_agreeing, pages_evaluated: c.pages_evaluated,
    }).then(null, (e) => console.error('wall_calibration_runs log insert failed:', e));

  if (action === 'confirm') {
    const { data: existing, error: exErr } = await db.from('wall_calibrations').select('*').eq('project_id', project_id).maybeSingle();
    if (exErr) return err(exErr.message, 500);
    if (!existing) return err('No calibration to confirm', 404);
    if (existing.status === 'confirmed') return ok(existing); // idempotent re-click
    const { data, error } = await db.from('wall_calibrations')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('project_id', project_id).eq('status', 'suggested')
      .select('*').single();
    if (error) return err(error.message, 500);
    await logRun('confirmed', data);
    return ok(data);
  }

  if (action === 'reject') {
    const { data: prior } = await db.from('wall_calibrations').select('status').eq('project_id', project_id).maybeSingle();
    const wasConfirmed = prior?.status === 'confirmed';
    const { data, error } = await db.from('wall_calibrations')
      .update({ status: 'rejected' }).eq('project_id', project_id).select('*').single();
    if (error) return err(error.message, 500);
    await logRun('rejected', data);

    if (wasConfirmed) {
      const { data: affected } = await db.from('device_instances').select('id, flags')
        .eq('project_id', project_id).eq('route_method', 'routed');
      for (const d of affected ?? []) {
        const flags = new Set(d.flags ?? []);
        flags.add('wall_calibration_stale');
        await db.from('device_instances').update({ flags: [...flags] }).eq('id', d.id);
      }
      data.devices_flagged_stale = affected?.length ?? 0;
    }
    return ok(data);
  }

  if (action === 'try-next') {
    const { data: cur, error: curErr } = await db.from('wall_calibrations').select('*').eq('project_id', project_id).maybeSingle();
    if (curErr) return err(curErr.message, 500);
    if (!cur) return err('No calibration to advance', 404);
    const nextIdx = cur.candidate_idx + 1;
    const next = cur.candidates[nextIdx];
    if (!next) return err('No further candidates — reject and use waypoints, or recalibrate', 200);
    const { data, error } = await db.from('wall_calibrations')
      .update({
        stroke_color: next.color, stroke_width: next.width, score: next.score,
        runner_up_score: cur.candidates[nextIdx + 1]?.score ?? null,
        candidate_idx: nextIdx, status: 'suggested', confirmed_at: null,
      })
      .eq('project_id', project_id).select('*').single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  const { candidates, pages_evaluated, pages_agreeing, preview_page_id } = body;
  if (!Array.isArray(candidates) || !candidates.length) return err('candidates array required (ranked, highest score first)');
  if (!Number.isFinite(pages_evaluated) || !Number.isFinite(pages_agreeing)) return err('pages_evaluated and pages_agreeing required');
  const winner = candidates[0];
  if (!winner.color || !Number.isFinite(winner.width) || !Number.isFinite(winner.score))
    return err('each candidate needs {color, width, score}');

  const { data, error } = await db.from('wall_calibrations').upsert({
    org_id: orgId, project_id,
    stroke_color: winner.color, stroke_width: winner.width, score: winner.score,
    runner_up_score: candidates[1]?.score ?? null,
    candidates, candidate_idx: 0, pages_evaluated, pages_agreeing,
    preview_page_id: preview_page_id ?? null,
    status: 'suggested', confirmed_at: null,
  }, { onConflict: 'project_id' }).select('*').single();
  if (error) return err(error.message, 500);
  return ok(data);
}

export const config = { path: '/api/wf/wf4/wall-calibrate' };
