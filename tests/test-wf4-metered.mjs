// tests/test-wf4-metered.mjs — metered usage logging + owner-only summary
// Run: node tests/test-wf4-metered.mjs   (no network, no model calls)
import { costFromUsage, isOwner, usageRow, meteredCreate } from '../netlify/functions/utils/metered.js';
import { summarize } from '../netlify/functions/wf4-usage.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};
const price = { input_per_mtok: 3, output_per_mtok: 15 };

// cost
eq('cost basic', costFromUsage({ input_tokens: 2000, output_tokens: 400 }, price), 0.012);
eq('cost with cache', costFromUsage({ input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 }, price), 0.00975);
eq('cost no price', costFromUsage({ input_tokens: 1 }, null), null);
eq('cost no usage', costFromUsage(null, price), null);

// owner check
eq('owner exact', isOwner('peter@biq-i.com', 'peter@biq-i.com'), true);
eq('owner case/space', isOwner(' Peter+SMCIS@winquest.ai ', 'a@b.com, peter+smcis@winquest.ai'), true);
eq('not owner', isOwner('estimator@smcis.com', 'peter@biq-i.com'), false);
eq('no list = nobody', isOwner('peter@biq-i.com', ''), false);
eq('no email', isOwner(null, 'peter@biq-i.com'), false);

// row shape
const ctx = { orgId: 1, projectId: 5, pageId: 9, pass: 'symbol', detail: 'WAP strip 3', userId: 'u' };
eq('usage row', usageRow(ctx, 'claude-sonnet-4-5', { input_tokens: 900, output_tokens: 120 }),
  { org_id: 1, project_id: 5, page_id: 9, pass: 'symbol', detail: 'WAP strip 3', model: 'claude-sonnet-4-5',
    input_tokens: 900, output_tokens: 120, cache_read_tokens: null, cache_write_tokens: null, called_by: 'u' });

// wrapper: runs the call, logs usage, never blocks; failed call is logged then re-thrown
function fakeSupabase(inserted) {
  const chain = (table) => ({
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: table === 'metered_prices' ? price : null }),
    insert: async (row) => { inserted.push(row); return { error: null }; },
  });
  return { schema: () => ({ from: (t) => chain(t) }) };
}
const logged = [];
const okAnthropic = { messages: { create: async () => ({ content: [{ text: '{}' }], usage: { input_tokens: 2000, output_tokens: 400 } }) } };
const resp = await meteredCreate(okAnthropic, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [] }, { ...ctx, supabase: fakeSupabase(logged) });
eq('wrapper returns response', resp.content[0].text, '{}');
eq('wrapper logged cost', [logged.length, logged[0].ok, logged[0].cost_usd, logged[0].page_id], [1, true, 0.012, 9]);

const logged2 = [];
const badAnthropic = { messages: { create: async () => { throw new Error('overloaded'); } } };
let threw = false;
try { await meteredCreate(badAnthropic, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [] }, { ...ctx, supabase: fakeSupabase(logged2) }); }
catch (e) { threw = e.message === 'overloaded'; }
eq('failed call re-thrown', threw, true);
eq('failed call logged', [logged2.length, logged2[0].ok, logged2[0].error], [1, false, 'overloaded']);

// logging failure never breaks the pass
const brokenDb = { schema: () => ({ from: () => ({ select() { return this; }, eq() { return this; },
  maybeSingle: async () => ({ data: price }), insert: async () => { throw new Error('db down'); } }) }) };
const resp3 = await meteredCreate(okAnthropic, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [] }, { ...ctx, supabase: brokenDb });
eq('log failure does not break call', !!resp3, true);

// owner summary
const calls = [
  { id: 1, org_id: 3, project_id: 5, page_id: 9, pass: 'pass_b', model: 'claude-sonnet-4-5', input_tokens: 2000, output_tokens: 400, cost_usd: 0.012, ok: true, created_at: '2026-09-27T10:00:00Z' },
  { id: 2, org_id: 3, project_id: 5, page_id: 9, pass: 'symbol', model: 'claude-sonnet-4-5', input_tokens: 1000, output_tokens: 200, cost_usd: 0.006, ok: true, created_at: '2026-09-27T10:01:00Z' },
  { id: 3, org_id: 3, project_id: 5, page_id: 10, pass: 'symbol', model: 'claude-sonnet-4-5', input_tokens: 1000, output_tokens: 200, cost_usd: 0.006, ok: false, created_at: '2026-09-28T09:00:00Z' },
  { id: 4, org_id: 1, project_id: 5, page_id: null, pass: 'discover:read_legend', model: 'other-model', input_tokens: 500, output_tokens: 100, cost_usd: null, ok: true, created_at: '2026-09-28T09:05:00Z' },
];
const s = summarize(calls, [{ model: 'claude-sonnet-4-5', ...price }], [{ id: 9, page_number: 3, title_text: 'T-101' }, { id: 10, page_number: 4 }]);
eq('totals', [s.totals.calls, s.totals.failed, s.totals.input_tokens, s.totals.output_tokens, s.totals.cost_now], [4, 1, 4500, 900, 0.024]);
eq('by pass order', s.by_pass.map((p) => [p.pass, p.calls]), [['symbol', 2], ['pass_b', 1], ['discover:read_legend', 1]]);
eq('by page', s.by_page.map((p) => [p.page_number, p.calls, p.cost_now]), [[3, 2, 0.018], [4, 1, 0.006]]);
eq('avg per page', s.avg_cost_per_page, 0.012);
eq('by day', s.by_day.map((d) => [d.day, d.calls]), [['2026-09-27', 2], ['2026-09-28', 2]]);
eq('unpriced flagged', s.unpriced_models, ['other-model']);
eq('by org (all orgs)', s.by_org.map((o) => [o.org_id, o.calls]), [[3, 3], [1, 1]]);
eq('admin account allowed', isOwner('peter@biq-i.com', 'peter@biq-i.com'), true);
eq('customer admin refused', isOwner('preardon@smcis.com', 'peter@biq-i.com'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
