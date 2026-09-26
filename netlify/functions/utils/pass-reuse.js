// netlify/functions/utils/pass-reuse.js
// Free reuse of metered-pass results (takeoff.pass_results). The key is a
// SHA-256 of the exact image the model would see + a variant string (prompt
// version, model, type description). Same key -> stored result, no model call.
// A reuse is also written to metered_calls with 0 tokens / $0 and
// detail 'reused', so the admin page shows what reuse saved.
// Storage failures never break a pass — worst case the model is called again.
// ─────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { td } from './takeoff-db.js';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export function variantKey(parts) {
  return sha256(JSON.stringify(parts));
}

export async function findStored(supabase, { orgId, pass, inputHash, variant }) {
  try {
    const db = td(supabase);
    const { data } = await db.from('pass_results').select('id, result, hits')
      .eq('org_id', orgId).eq('pass', pass).eq('input_hash', inputHash).eq('variant', variant).maybeSingle();
    if (!data) return null;
    await db.from('pass_results').update({ hits: (data.hits ?? 0) + 1 }).eq('id', data.id);
    return data.result;
  } catch (e) {
    console.warn('[pass-reuse] lookup failed:', e?.message);
    return null;
  }
}

export async function saveStored(supabase, { orgId, pass, inputHash, variant, result, pageId }) {
  try {
    const { error } = await td(supabase).from('pass_results').upsert(
      { org_id: orgId, pass, input_hash: inputHash, variant, result, first_page_id: pageId ?? null },
      { onConflict: 'org_id,pass,input_hash,variant', ignoreDuplicates: true });
    if (error) console.warn('[pass-reuse] save failed:', error.message);
  } catch (e) {
    console.warn('[pass-reuse] save failed:', e?.message);
  }
}

export async function logReuse(supabase, ctx, model) {
  try {
    await td(supabase).from('metered_calls').insert({
      org_id: ctx.orgId, project_id: ctx.projectId ?? null, page_id: ctx.pageId ?? null,
      pass: ctx.pass, detail: ctx.detail ? `reused: ${ctx.detail}` : 'reused', model,
      input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0, ok: true, called_by: ctx.userId ?? null,
    });
  } catch (e) {
    console.warn('[pass-reuse] reuse log failed:', e?.message);
  }
}
