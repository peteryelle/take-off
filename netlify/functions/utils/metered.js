// netlify/functions/utils/metered.js
// Every WF4 model call goes through meteredCreate(). It does NOT gate, cap or
// prompt — the call just runs. It records what the call used so the owner can
// see token use and estimated cost per page / pass / project
// (takeoff.metered_calls, read only via /api/wf/wf4/usage by owner emails).
//
//   const msg = await meteredCreate(anthropic, { model, max_tokens, messages }, {
//     supabase, orgId, projectId, pageId, pass: 'pass_b', detail: null, userId,
//   });
//
// Logging can never break a pass: a failed insert is only console-warned.
// A failed model call is logged (ok = false) and then re-thrown unchanged, so
// each pass keeps its existing error handling.
// ─────────────────────────────────────────────────────────────────

import { td } from './takeoff-db.js';

// Cost in USD from the API's usage block and a price row. Pure (unit-tested).
// Cache reads/writes are priced at the standard Anthropic ratios to the input
// price (read 0.1x, write 1.25x); they are 0 unless prompt caching is used.
export function costFromUsage(usage, price) {
  if (!usage || !price) return null;
  const inP = Number(price.input_per_mtok), outP = Number(price.output_per_mtok);
  if (!Number.isFinite(inP) || !Number.isFinite(outP)) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const usd = (n(usage.input_tokens) * inP
    + n(usage.output_tokens) * outP
    + n(usage.cache_read_input_tokens) * inP * 0.1
    + n(usage.cache_creation_input_tokens) * inP * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// Price rows change rarely — cache per function instance for 5 minutes.
const priceCache = new Map();   // model -> { row, at }
async function priceFor(supabase, model) {
  const hit = priceCache.get(model);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.row;
  const { data } = await td(supabase).from('metered_prices')
    .select('input_per_mtok, output_per_mtok').eq('model', model).maybeSingle();
  priceCache.set(model, { row: data ?? null, at: Date.now() });
  return data ?? null;
}

export function usageRow(ctx, model, usage, extra = {}) {
  return {
    org_id: ctx.orgId,
    project_id: ctx.projectId ?? null,
    page_id: ctx.pageId ?? null,
    pass: ctx.pass,
    detail: ctx.detail ?? null,
    model,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read_tokens: usage?.cache_read_input_tokens ?? null,
    cache_write_tokens: usage?.cache_creation_input_tokens ?? null,
    called_by: ctx.userId ?? null,
    ...extra,
  };
}

export async function meteredCreate(anthropic, params, ctx) {
  const started = Date.now();
  const log = async (usage, extra) => {
    try {
      const price = usage ? await priceFor(ctx.supabase, params.model) : null;
      const row = usageRow(ctx, params.model, usage, {
        cost_usd: costFromUsage(usage, price),
        duration_ms: Date.now() - started,
        ...extra,
      });
      const { error } = await td(ctx.supabase).from('metered_calls').insert(row);
      if (error) console.warn('[metered] log insert failed:', error.message);
    } catch (e) {
      console.warn('[metered] log failed:', e?.message);
    }
  };

  let resp;
  try {
    resp = await anthropic.messages.create(params);
  } catch (e) {
    await log(null, { ok: false, error: String(e?.message ?? e).slice(0, 500) });
    throw e;
  }
  await log(resp?.usage ?? null, { ok: true });
  return resp;
}

// Owner check for the usage endpoint: TAKEOFF_OWNER_EMAILS is a
// comma-separated list (case-insensitive), e.g. "peter+smcis@winquest.ai".
export function isOwner(email, list = process.env.TAKEOFF_OWNER_EMAILS) {
  if (!email || !list) return false;
  const owners = String(list).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return owners.includes(String(email).trim().toLowerCase());
}
