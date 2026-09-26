// tests/test-wf4-pass-reuse.mjs — free reuse of metered-pass results
// Run: node tests/test-wf4-pass-reuse.mjs   (no network, no model calls)
import { sha256, variantKey, findStored, saveStored, logReuse } from '../netlify/functions/utils/pass-reuse.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

// in-memory stand-in for the two tables
function fakeDb() {
  const rows = { pass_results: [], metered_calls: [] };
  let nextId = 1;
  const from = (t) => {
    const f = {};
    const q = { filters: f,
      select() { return q; },
      eq(k, v) { f[k] = v; return q; },
      maybeSingle: async () => ({ data: rows[t].find((r) => Object.entries(f).every(([k, v]) => String(r[k]) === String(v))) ?? null }),
      update(u) { return { eq: async (k, v) => { rows[t].filter((r) => String(r[k]) === String(v)).forEach((r) => Object.assign(r, u)); return { error: null }; } }; },
      upsert: async (row) => {
        const dup = rows[t].find((r) => r.org_id === row.org_id && r.pass === row.pass && r.input_hash === row.input_hash && r.variant === row.variant);
        if (!dup) rows[t].push({ id: nextId++, hits: 0, ...row });
        return { error: null };
      },
      insert: async (row) => { rows[t].push(row); return { error: null }; },
    };
    return q;
  };
  return { rows, client: { schema: () => ({ from }) } };
}

eq('sha256 stable', sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
eq('variant changes with description', variantKey(['symbol.v1', 'm', 'round WAP']) === variantKey(['symbol.v1', 'm', 'square WAP']), false);
eq('variant stable', variantKey(['pass_b.v1', 'm']), variantKey(['pass_b.v1', 'm']));

const { rows, client } = fakeDb();
const key = { orgId: 3, pass: 'pass_b', inputHash: sha256('IMAGE-A'), variant: variantKey(['pass_b.v1', 'm']) };
eq('miss before save', await findStored(client, key), null);
await saveStored(client, { ...key, result: { scale: { display_label: '1/8"' } }, pageId: 9 });
await saveStored(client, { ...key, result: { scale: { display_label: 'OTHER' } }, pageId: 10 });   // duplicate ignored
eq('one stored row', rows.pass_results.length, 1);
eq('hit returns first result', await findStored(client, key), { scale: { display_label: '1/8"' } });
eq('hit counted', rows.pass_results[0].hits, 1);
eq('other org never reuses', await findStored(client, { ...key, orgId: 5 }), null);
eq('other image never reuses', await findStored(client, { ...key, inputHash: sha256('IMAGE-B') }), null);

await logReuse(client, { orgId: 3, projectId: 1, pageId: 11, pass: 'pass_b', detail: null, userId: 'u' }, 'claude-sonnet-4-5');
const r = rows.metered_calls[0];
eq('reuse logged at $0', [r.pass, r.detail, r.input_tokens, r.output_tokens, r.cost_usd, r.page_id], ['pass_b', 'reused', 0, 0, 0, 11]);

// storage failure never throws
const broken = { schema: () => ({ from: () => { throw new Error('db down'); } }) };
eq('lookup failure -> miss', await findStored(broken, key), null);
let threw = false; try { await saveStored(broken, { ...key, result: {} }); } catch { threw = true; }
eq('save failure does not throw', threw, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
