// netlify/functions/wf-wf3.js
// WF3 · OSP site fiber. The engine (public/lib/osp-extract.js runOsp) runs in
// the browser — free. This function stores and serves the results.
//
// GET  /api/wf/wf3?project_id=1  → { runs, nodes, segments, callouts, discrepancies }
// POST { action: "save_sheet", project_id, page_id, sheet_revision_id, is_overview, result }
//        Replaces everything stored for that sheet (re-measuring discards edits on it).
// POST { action: "override_segment", segment_id, row, basis, takeoff }
//        A corrected segment row, with the reason; `takeoff` is the sheet's
//        recomputed totals. The first correction keeps the engine's original row.
// POST { action: "set_discrepancy", id, status }   status: rfi | verify | resolved
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';

const NODE_KIND = { MH: 'MH', HH: 'HH', JUNCTION: 'junction', BEND: 'junction', END: 'end' };
const ROUTE = { new: 'new', existing: 'existing', mixed: 'new' };
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const projectId = new URL(req.url).searchParams.get('project_id');
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    const q = (t, cols) => db.from(t).select(cols).eq('project_id', projectId).order('id');
    const [runs, nodes, segs, cos, disc] = await Promise.all([
      q('osp_sheet_runs', 'id, page_id, sheet_revision_id, sheet_number, is_overview, scale_ft_per_in, limits, takeoff, problems, stats, run_at'),
      q('osp_nodes', 'id, page_id, label, kind, x_norm, y_norm, data'),
      q('osp_segments', 'id, page_id, label, source, override_basis, original_value, data'),
      q('osp_callouts', 'id, page_id, label, segment_id, data'),
      q('osp_discrepancies', 'id, page_id, label, status, category, located_at, data'),
    ]);
    for (const r of [runs, nodes, segs, cos, disc]) if (r.error) return err(r.error.message, 500);
    return ok({ runs: runs.data, nodes: nodes.data, segments: segs.data, callouts: cos.data, discrepancies: disc.data });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let b;
  try { b = await req.json(); } catch { return err('Invalid JSON'); }

  let projectId = b.project_id;
  if (!projectId && b.segment_id) projectId = (await db.from('osp_segments').select('project_id').eq('id', b.segment_id).maybeSingle()).data?.project_id;
  if (!projectId && b.id) projectId = (await db.from('osp_discrepancies').select('project_id').eq('id', b.id).maybeSingle()).data?.project_id;
  if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);

  try {
    if (b.action === 'save_sheet') return await saveSheet(db, orgId, user, projectId, b);
    if (b.action === 'override_segment') return await overrideSegment(db, user, b);
    if (b.action === 'set_discrepancy') {
      if (!['rfi', 'verify', 'resolved'].includes(b.status)) return err('Unknown status');
      const { error } = await db.from('osp_discrepancies').update({ status: b.status }).eq('id', b.id);
      if (error) return err(error.message, 500);
      return ok({ ok: true });
    }
    return err('Unknown action');
  } catch (e) {
    return err(e.message || String(e), 500);
  }
}

async function saveSheet(db, orgId, user, projectId, b) {
  const { data: page } = await db.from('pages').select('id, project_id').eq('id', b.page_id).maybeSingle();
  if (!page || String(page.project_id) !== String(projectId)) return err('Page not found in this project', 404);
  const r = b.result || {};
  const base = { org_id: orgId, project_id: projectId, page_id: b.page_id, sheet_revision_id: b.sheet_revision_id || null, source: 'extracted', entered_by: user.id };

  // Replace this sheet's rows (children first).
  for (const t of ['osp_discrepancies', 'osp_callouts', 'osp_segments', 'osp_nodes']) {
    const { error } = await db.from(t).delete().eq('page_id', b.page_id);
    if (error) return err(`${t}: ${error.message}`, 500);
  }

  const nodeId = new Map();
  if (r.nodes?.length) {
    const { data, error } = await db.from('osp_nodes').insert(r.nodes.map((n) => ({
      ...base, label: n.id, kind: NODE_KIND[n.type] || 'junction', x_norm: n.x, y_norm: n.y, data: n,
    }))).select('id, label');
    if (error) return err(`nodes: ${error.message}`, 500);
    for (const x of data) nodeId.set(x.label, x.id);
  }
  const segId = new Map();
  if (r.segments?.length) {
    const { data, error } = await db.from('osp_segments').insert(r.segments.map((s) => ({
      ...base, label: s.segment, from_node_id: nodeId.get(s.from) || null, to_node_id: nodeId.get(s.to) || null,
      route: ROUTE[s.route] || null, total_ft: num(s.total_ft), new_ft: num(s.new_ft), existing_ft: num(s.existing_ft),
      bends_deg: num(s.bends_deg), core: s.core || null, cables: num(s.cables), n_4in: num(s.n_4in), n_1in_fa: num(s.n_1in_fa),
      spare: num(s.spare), elec: num(s.elec) ? true : false, pathway: s.pathway || null, data: s,
    }))).select('id, label');
    if (error) return err(`segments: ${error.message}`, 500);
    for (const x of data) segId.set(x.label, x.id);
  }
  if (r.callouts?.length) {
    const { error } = await db.from('osp_callouts').insert(r.callouts.map((c) => ({
      ...base, label: c.id, segment_id: segId.get(c.segment) || null, callout_text: c.raw || '',
      match_method: c.method === 'leader' ? 'leader' : 'proximity', data: c,
    })));
    if (error) return err(`callouts: ${error.message}`, 500);
  }
  if (r.discrepancies?.length) {
    const { error } = await db.from('osp_discrepancies').insert(r.discrepancies.map((d) => ({
      ...base, label: d.item, category: d.category, status: d.status === 'RFI candidate' ? 'rfi' : 'verify',
      located_at: d.at, expected: d.expected, found: d.found, whats_off: d.whats_off, rfi_text: d.rfi || null, data: d,
    })));
    if (error) return err(`discrepancies: ${error.message}`, 500);
  }

  const run = {
    org_id: orgId, project_id: projectId, page_id: b.page_id, sheet_revision_id: b.sheet_revision_id || null,
    sheet_number: r.sheet || null, is_overview: !!b.is_overview, scale_ft_per_in: num(r.scale),
    limits: r.limits || {}, takeoff: r.takeoff || [], problems: r.problems || [],
    stats: { fragments: r.fragments, chains: r.chains, tol: r.tol, scale_measured: r.scale_measured, gap_pct: r.gap_pct },
    run_by: user.id, run_at: new Date().toISOString(),
  };
  const { error: runErr } = await db.from('osp_sheet_runs').upsert(run, { onConflict: 'page_id' });
  if (runErr) return err(`run: ${runErr.message}`, 500);

  // Measuring changes WF3's data: a confirmed WF3 (or WF7, which reads it) needs review.
  await db.from('workflow_steps').update({ status: 'stale', stale_reason: `${r.sheet || 'OSP sheet'} re-measured` })
    .eq('project_id', projectId).in('step_code', ['WF3', 'WF7']).eq('status', 'confirmed');
  await db.from('workflow_steps').update({ status: 'in_review' }).eq('project_id', projectId).eq('step_code', 'WF3').eq('status', 'open');

  return ok({ nodes: nodeId.size, segments: segId.size, callouts: r.callouts?.length || 0, discrepancies: r.discrepancies?.length || 0 });
}

async function overrideSegment(db, user, b) {
  const basis = String(b.basis || '').trim();
  if (!basis) return err('A reason is required for a correction');
  const { data: seg, error } = await db.from('osp_segments').select('id, page_id, source, original_value, data').eq('id', b.segment_id).single();
  if (error) return err(error.message, 500);
  const row = b.row || {};
  const { error: upErr } = await db.from('osp_segments').update({
    total_ft: num(row.total_ft), new_ft: num(row.new_ft), existing_ft: num(row.existing_ft), core: row.core || null,
    cables: num(row.cables), n_4in: num(row.n_4in), spare: num(row.spare), data: row,
    source: 'edited', original_value: seg.source === 'extracted' ? seg.data : seg.original_value,
    override_basis: basis.slice(0, 300), entered_by: user.id, entered_at: new Date().toISOString(),
  }).eq('id', seg.id);
  if (upErr) return err(upErr.message, 500);
  if (Array.isArray(b.takeoff)) await db.from('osp_sheet_runs').update({ takeoff: b.takeoff }).eq('page_id', seg.page_id);
  return ok({ ok: true });
}

export const config = { path: '/api/wf/wf3' };
