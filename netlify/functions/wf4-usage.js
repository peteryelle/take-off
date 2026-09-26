// netlify/functions/wf4-usage.js
// PLATFORM ADMIN ONLY — token use and estimated cost of metered (LLM) passes,
// across ALL organizations. Feeds the admin landing page; never shown to
// customer users (including a customer org's own owner/admin).
//
// GET /api/wf/wf4/usage                    every org and project
// GET /api/wf/wf4/usage?org_id=3           one organization
// GET /api/wf/wf4/usage?project_id=12      one project, with per-page detail
//
// Access: the signed-in account's email must be in TAKEOFF_OWNER_EMAILS
// (Netlify env, comma-separated, e.g. "peter@biq-i.com"). This is an access
// list only — nothing is ever emailed. Anyone else gets a plain 404; the
// endpoint does not reveal that it exists.
//
// Costs are shown two ways: `cost_logged` (price at the time of each call) and
// `cost_now` (tokens x the current metered_prices row), so correcting a price
// corrects the history.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td } from './utils/takeoff-db.js';
import { isOwner, costFromUsage } from './utils/metered.js';

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

const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function summarize(calls, prices, pages = []) {
  const priceByModel = new Map(prices.map((p) => [p.model, p]));
  const pageById = new Map(pages.map((p) => [String(p.id), p]));
  const blank = () => ({ calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, cost_logged: 0, cost_now: 0 });
  const add = (acc, c, now) => {
    acc.calls++; if (!c.ok) acc.failed++;
    acc.input_tokens += c.input_tokens ?? 0;
    acc.output_tokens += c.output_tokens ?? 0;
    acc.cost_logged += Number(c.cost_usd ?? 0);
    acc.cost_now += now ?? 0;
  };
  const totals = blank(), byPass = new Map(), byPage = new Map(), byProject = new Map(), byDay = new Map(), byOrg = new Map();
  const unpriced = new Set();

  for (const c of calls) {
    const price = priceByModel.get(c.model);
    if (!price) unpriced.add(c.model);
    const now = costFromUsage({
      input_tokens: c.input_tokens, output_tokens: c.output_tokens,
      cache_read_input_tokens: c.cache_read_tokens, cache_creation_input_tokens: c.cache_write_tokens,
    }, price) ?? 0;
    add(totals, c, now);
    const passKey = c.pass;
    if (!byPass.has(passKey)) byPass.set(passKey, { pass: passKey, ...blank() });
    add(byPass.get(passKey), c, now);
    const orgKey = String(c.org_id ?? '—');
    if (!byOrg.has(orgKey)) byOrg.set(orgKey, { org_id: c.org_id ?? null, ...blank() });
    add(byOrg.get(orgKey), c, now);
    const projKey = String(c.project_id ?? '—');
    if (!byProject.has(projKey)) byProject.set(projKey, { project_id: c.project_id ?? null, ...blank() });
    add(byProject.get(projKey), c, now);
    const day = String(c.created_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { day, ...blank() });
    add(byDay.get(day), c, now);
    if (c.page_id != null) {
      const k = String(c.page_id);
      const p = pageById.get(k);
      if (!byPage.has(k)) byPage.set(k, { page_id: c.page_id, page_number: p?.page_number ?? null, title: p?.title_text ?? null, ...blank() });
      add(byPage.get(k), c, now);
    }
  }
  const fin = (o) => ({ ...o, cost_logged: r6(o.cost_logged), cost_now: r6(o.cost_now) });
  return {
    totals: fin(totals),
    by_org: [...byOrg.values()].map(fin).sort((a, b) => b.cost_now - a.cost_now),
    by_pass: [...byPass.values()].map(fin).sort((a, b) => (b.cost_now - a.cost_now) || (b.calls - a.calls)),
    by_project: [...byProject.values()].map(fin).sort((a, b) => b.cost_now - a.cost_now),
    by_page: [...byPage.values()].map(fin).sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0)),
    by_day: [...byDay.values()].map(fin).sort((a, b) => a.day.localeCompare(b.day)),
    avg_cost_per_page: byPage.size ? r6(totals.cost_now / byPage.size) : null,
    unpriced_models: [...unpriced],
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'GET') return err('Not found', 404);

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, user } = gate;
  if (!isOwner(user?.email)) return err('Not found', 404);

  const db = td(supabase);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');
  const orgFilter = url.searchParams.get('org_id');

  try {
    const [calls, prices] = await Promise.all([
      fetchAll(() => {
        let q = db.from('metered_calls')
          .select('id, org_id, project_id, page_id, pass, detail, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok, created_at');
        if (orgFilter) q = q.eq('org_id', orgFilter);
        if (projectId) q = q.eq('project_id', projectId);
        return q;
      }),
      db.from('metered_prices').select('*').then((r) => r.data ?? []),
    ]);
    const pages = projectId
      ? await fetchAll(() => db.from('pages').select('id, page_number, title_text').eq('project_id', projectId))
      : [];
    // Names for the admin page (organizations are in public, projects in takeoff).
    const [{ data: orgs }, { data: projects }] = await Promise.all([
      supabase.from('organizations').select('id, name'),
      db.from('projects').select('id, name, org_id'),
    ]);
    const orgName = new Map((orgs ?? []).map((o) => [String(o.id), o.name]));
    const projName = new Map((projects ?? []).map((p) => [String(p.id), p.name]));
    const s = summarize(calls, prices, pages);
    s.by_org = s.by_org.map((o) => ({ ...o, org_name: orgName.get(String(o.org_id)) ?? null }));
    s.by_project = s.by_project.map((p) => ({ ...p, project_name: projName.get(String(p.project_id)) ?? null }));
    return ok({
      scope: projectId ? { project_id: Number(projectId) } : orgFilter ? { org_id: Number(orgFilter) } : { all_orgs: true },
      prices,
      ...s,
      recent: calls.slice(-50).reverse(),
    });
  } catch (e) {
    return err(e.message, 500);
  }
}

export const config = { path: '/api/wf/wf4/usage' };
