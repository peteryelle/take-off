// netlify/functions/wf-projects.js
// v2 workflow projects (takeoff schema).
//
// GET  /api/wf/projects                         — list the org's projects with step statuses
// GET  /api/wf/projects?id=123                  — one project: steps, library, file/sheet counts
// GET  /api/wf/projects?copy_sources=1          — past projects whose library can be copied
// POST /api/wf/projects { action: "create", ... }     — project + 8 step rows + its own library
// POST /api/wf/projects { action: "set_scope", ... }  — mark a step in scope / N/A
// ─────────────────────────────────────────────────────────────────
// Libraries are per project by default. "Copy from a previous project" brings
// the other library's device types over as UNVERIFIED: they cannot count
// until re-checked on this drawing set.

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { initialStepRows, STEP_CODES } from '../../public/lib/wf-steps.js';

const TYPE_COPY_COLS =
  'id, name, ports, detect_mode, label_text, crop_path, detection_config, legend_suggestion, bom_item';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);
  const url = new URL(req.url);

  // ── GET ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // Past projects to copy a library from (same client listed first).
    if (url.searchParams.get('copy_sources')) {
      const client = url.searchParams.get('client') || '';
      const { data: libs, error } = await db
        .from('device_libraries')
        .select('id, name, client, ae_firm, project_id, projects!device_libraries_project_id_fkey(name, number), device_types(count)')
        .eq('org_id', orgId)
        .not('project_id', 'is', null)
        .order('created_at', { ascending: false });
      if (error) return err(error.message, 500);
      const rows = (libs || [])
        .map((l) => ({
          library_id: l.id,
          project_id: l.project_id,
          project_name: l.projects?.name || l.name,
          project_number: l.projects?.number || null,
          client: l.client,
          ae_firm: l.ae_firm,
          device_types: l.device_types?.[0]?.count ?? 0,
        }))
        .filter((r) => r.device_types > 0)
        .sort((a, b) => Number(b.client === client) - Number(a.client === client));
      return ok(rows);
    }

    // One project.
    const id = url.searchParams.get('id');
    if (id) {
      if (!(await assertWfProjectInOrg(supabase, id, orgId))) return err('Project not found', 404);
      const [proj, steps, docs, sheets] = await Promise.all([
        db.from('projects')
          .select('id, name, number, client, co_pricing_basis, device_library_id, parts_catalog_id, bom_template_id, created_at')
          .eq('id', id).single(),
        db.from('workflow_steps')
          .select('step_code, status, source_mode, stale_reason, confirmed_at')
          .eq('project_id', id),
        db.from('documents').select('step_code', { count: 'exact' }).eq('project_id', id),
        db.from('sheets').select('id', { count: 'exact', head: true }).eq('project_id', id),
      ]);
      for (const r of [proj, steps, docs, sheets]) if (r.error) return err(r.error.message, 500);

      const docsByStep = {};
      for (const d of docs.data || []) docsByStep[d.step_code] = (docsByStep[d.step_code] || 0) + 1;

      let library = null;
      if (proj.data.device_library_id) {
        const { data: lib } = await db
          .from('device_libraries')
          .select('id, name, based_on_library_id, device_types(count)')
          .eq('id', proj.data.device_library_id).maybeSingle();
        if (lib) library = { id: lib.id, name: lib.name, copied: !!lib.based_on_library_id, device_types: lib.device_types?.[0]?.count ?? 0 };
      }

      return ok({
        project: proj.data,
        steps: sortSteps(steps.data || []),
        library,
        documents_by_step: docsByStep,
        documents: docs.count ?? 0,
        sheets: sheets.count ?? 0,
      });
    }

    // List.
    const { data, error } = await db
      .from('projects')
      .select('id, name, number, client, created_at, workflow_steps(step_code, status)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });
    if (error) return err(error.message, 500);
    return ok((data || []).map((p) => ({ ...p, workflow_steps: sortSteps(p.workflow_steps || []) })));
  }

  // ── POST ───────────────────────────────────────────────────────
  if (req.method !== 'POST') return err('Method not allowed', 405);
  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  if (body.action === 'create') return createProject(db, orgId, user, body);

  if (body.action === 'set_scope') {
    const { project_id, step_code, in_scope } = body;
    if (!STEP_CODES.includes(step_code) || step_code === 'WF8') return err('step_code must be WF1–WF7');
    if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err('Project not found', 404);
    const { data: cur, error: curErr } = await db
      .from('workflow_steps').select('status')
      .eq('project_id', project_id).eq('step_code', step_code).single();
    if (curErr) return err(curErr.message, 500);
    // Back in scope -> open. Never overwrite real progress when re-adding.
    const status = in_scope ? (cur.status === 'not_applicable' ? 'open' : cur.status) : 'not_applicable';
    const { data, error } = await db
      .from('workflow_steps').update({ status })
      .eq('project_id', project_id).eq('step_code', step_code)
      .select('step_code, status').single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  return err('Unknown action');
}

// ── create: project, then steps, then library. Supabase-js has no
// transaction, so on any failure we delete the project; steps and the
// project-owned library cascade with it.
async function createProject(db, orgId, user, body) {
  const name = (body.name || '').trim();
  if (!name) return err('Project name is required');
  const pricing = body.co_pricing_basis === 'current' ? 'current' : 'bid';
  const inScope = Array.isArray(body.in_scope) ? body.in_scope.filter((c) => STEP_CODES.includes(c)) : null;

  const { data: proj, error: pErr } = await db
    .from('projects')
    .insert({
      org_id: orgId,
      name,
      number: body.number || null,
      client: body.client || null,
      co_pricing_basis: pricing,
      bom_template_id: body.bom_template_id || null,
      parts_catalog_id: body.parts_catalog_id || null,
      created_by: user.id,
    })
    .select('id, name').single();
  if (pErr) return err(pErr.message, 500);

  const rollback = async (message) => {
    await db.from('projects').delete().eq('id', proj.id);
    return err(message, 500);
  };

  const { error: sErr } = await db
    .from('workflow_steps')
    .insert(initialStepRows(inScope).map((r) => ({ ...r, org_id: orgId, project_id: proj.id })));
  if (sErr) return rollback(`Could not create steps: ${sErr.message}`);

  // Optional source library to copy from — must be in this org.
  let source = null;
  if (body.copy_from_library_id) {
    const { data: src } = await db
      .from('device_libraries').select('id, ae_firm')
      .eq('id', body.copy_from_library_id).eq('org_id', orgId).maybeSingle();
    if (!src) return rollback('Library to copy from was not found in your organization');
    source = src;
  }

  const { data: lib, error: lErr } = await db
    .from('device_libraries')
    .insert({
      org_id: orgId,
      name: `${name} — library`,
      client: body.client || null,
      ae_firm: body.ae_firm || source?.ae_firm || null,
      project_id: proj.id,
      based_on_library_id: source?.id || null,
      created_by: user.id,
    })
    .select('id').single();
  if (lErr) return rollback(`Could not create library: ${lErr.message}`);

  let copied = 0;
  if (source) {
    const { data: types, error: tErr } = await db
      .from('device_types').select(TYPE_COPY_COLS).eq('library_id', source.id);
    if (tErr) return rollback(`Could not read library to copy: ${tErr.message}`);
    if (types?.length) {
      const rows = types.map(({ id, ...t }) => ({
        ...t,
        org_id: orgId,
        library_id: lib.id,
        verified: false,
        copied_from_type_id: id,
        created_by: user.id,
      }));
      const { error: cErr } = await db.from('device_types').insert(rows);
      if (cErr) return rollback(`Could not copy device types: ${cErr.message}`);
      copied = rows.length;
    }
  }

  const { error: uErr } = await db.from('projects').update({ device_library_id: lib.id }).eq('id', proj.id);
  if (uErr) return rollback(`Could not attach library: ${uErr.message}`);

  return ok({ id: proj.id, name: proj.name, library_id: lib.id, device_types_copied: copied }, 201);
}

function sortSteps(rows) {
  return [...rows].sort((a, b) => STEP_CODES.indexOf(a.step_code) - STEP_CODES.indexOf(b.step_code));
}

export const config = { path: '/api/wf/projects' };
