// netlify/functions/wf-wf2.js
// WF2 · Schedule — the TR registry (takeoff.trs).
//
// GET  /api/wf/wf2?project_id=1   → { trs }
// POST { action: "save_trs", project_id, sheet_revision_id, basis, rows: [...] }
//   rows: { tr_number, building, level, cat6a_terminations, min_patch_panels,
//           source: 'extracted'|'edited'|'manual', original_value?, override_basis? }
//   Replaces the registry with `rows` (matched to existing TRs by the
//   punctuation-insensitive name, so ids and links survive a re-read).
//   If anything changed, confirmed later steps are marked "changed", and TR
//   names typed in other steps are linked to the matching registry row.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { normalizeTrName, resolveTrMatch } from '../../public/lib/normalize-tr-name.js';

const FIELDS = ['building', 'level', 'cat6a_terminations', 'min_patch_panels'];
const LINKED = ['tr_pins', 'device_instances', 'tr_room_devices', 'riser_feeds', 'osp_nodes'];
const toInt = (v) => (v === '' || v == null ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const projectId = new URL(req.url).searchParams.get('project_id');
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    const { data, error } = await db.from('trs')
      .select('id, tr_number, building, level, cat6a_terminations, min_patch_panels, source, original_value, override_basis, sheet_revision_id, entered_at')
      .eq('project_id', projectId).order('tr_number');
    if (error) return err(error.message, 500);
    return ok({ trs: data });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let b;
  try { b = await req.json(); } catch { return err('Invalid JSON'); }
  if (b.action !== 'save_trs') return err('Unknown action');
  if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
  const rows = Array.isArray(b.rows) ? b.rows : [];

  // Validate.
  const seen = new Set();
  for (const r of rows) {
    const name = String(r.tr_number || '').trim();
    if (!name) return err('Every row needs a TR number');
    const k = normalizeTrName(name);
    if (seen.has(k)) return err(`TR ${name} appears twice`);
    seen.add(k);
    for (const f of ['cat6a_terminations', 'min_patch_panels']) if (Number.isNaN(toInt(r[f]))) return err(`${name}: ${f.replace(/_/g, ' ')} must be a whole number`);
    if (!['extracted', 'edited', 'manual'].includes(r.source)) return err(`${name}: unknown source`);
    if (r.source !== 'extracted' && !String(r.override_basis || b.basis || '').trim()) return err(`${name}: a reason is required for edited or hand-entered rows`);
  }

  const { data: existing, error: exErr } = await db.from('trs')
    .select('id, tr_number, building, level, cat6a_terminations, min_patch_panels, source').eq('project_id', b.project_id);
  if (exErr) return err(exErr.message, 500);
  const byKey = new Map((existing || []).map((r) => [normalizeTrName(r.tr_number), r]));

  let inserted = 0, updated = 0, removed = 0;
  const keep = new Set();
  for (const r of rows) {
    const rec = {
      tr_number: String(r.tr_number).trim(),
      building: r.building ? String(r.building).trim() : null,
      level: r.level ? String(r.level).trim() : null,
      cat6a_terminations: toInt(r.cat6a_terminations),
      min_patch_panels: toInt(r.min_patch_panels),
      source: r.source,
      sheet_revision_id: r.source === 'manual' ? null : (b.sheet_revision_id || null),
      original_value: r.source === 'edited' ? (r.original_value || null) : null,
      override_basis: r.source === 'extracted' ? null : String(r.override_basis || b.basis).slice(0, 300),
      entered_by: user.id,
      entered_at: new Date().toISOString(),
    };
    const prev = byKey.get(normalizeTrName(rec.tr_number));
    if (prev) {
      keep.add(prev.id);
      const same = prev.tr_number === rec.tr_number && prev.source === rec.source && FIELDS.every((f) => String(prev[f] ?? '') === String(rec[f] ?? ''));
      if (same) continue;
      const { error } = await db.from('trs').update(rec).eq('id', prev.id);
      if (error) return err(`${rec.tr_number}: ${error.message}`, 500);
      updated++;
    } else {
      const { data, error } = await db.from('trs').insert({ ...rec, org_id: orgId, project_id: b.project_id }).select('id').single();
      if (error) return err(`${rec.tr_number}: ${error.message}`, 500);
      keep.add(data.id);
      inserted++;
    }
  }
  const drop = (existing || []).filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) {
    const { error } = await db.from('trs').delete().in('id', drop);
    if (error) return err(error.message, 500);
    removed = drop.length;
  }

  const changed = inserted + updated + removed > 0;
  let staled = [];
  if (changed) {
    const { data: st } = await db.from('workflow_steps')
      .update({ status: 'stale', stale_reason: 'TR schedule changed in WF2' })
      .eq('project_id', b.project_id).in('step_code', ['WF3', 'WF4', 'WF5', 'WF6', 'WF7']).eq('status', 'confirmed')
      .select('step_code');
    staled = (st || []).map((s) => s.step_code);
  }
  const linked = await linkTrNames(db, b.project_id);
  return ok({ inserted, updated, removed, unchanged: rows.length - inserted - updated, staled, linked });
}

// Link TR names typed in other steps to registry rows, using the repo's
// staged matcher (exact, then punctuation-stripped, then "-1" suffix).
// Ambiguous or unmatched names are left for the user in that step.
async function linkTrNames(db, projectId) {
  const { data: trs } = await db.from('trs').select('id, tr_number').eq('project_id', projectId);
  if (!trs?.length) return 0;
  let n = 0;
  for (const table of LINKED) {
    const { data: rows } = await db.from(table).select('id, tr_name, tr_id').eq('project_id', projectId).not('tr_name', 'is', null);
    const names = [...new Set((rows || []).map((r) => r.tr_name))];
    for (const name of names) {
      const m = resolveTrMatch(name, trs);
      const row = m.match ? trs.find((t) => t.tr_number === m.match) : null;
      const target = row ? row.id : null;
      const ids = rows.filter((r) => r.tr_name === name && r.tr_id !== target).map((r) => r.id);
      if (!ids.length) continue;
      const { error } = await db.from(table).update({ tr_id: target }).in('id', ids);
      if (!error && target) n += ids.length;
    }
  }
  return n;
}

export const config = { path: '/api/wf/wf2' };
