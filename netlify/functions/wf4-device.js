// netlify/functions/wf4-device.js
// WF4 copy of device-instance.js — persists a device's cull (exclude/restore)
// state on its takeoff.device_instances row.
//
// PATCH /api/wf/wf4/device   { id, flags?, cull_category?, cull_reason? }
//
// Each field is independently optional (present vs absent): omitted fields
// are left untouched, so the same call clears a cull. `excluded` (read by the
// BOM) is kept in step with the 'manual_excluded' flag.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td } from './utils/takeoff-db.js';
import { cullUpdate } from './utils/wf4-map.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'PATCH') return err('PATCH required', 405);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }
  if (!body.id) return err('id required');
  const updates = cullUpdate(body);
  if (!Object.keys(updates).length) return err('at least one of flags, cull_category, cull_reason required');

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;
  const db = td(supabase);

  const { data: row, error: findErr } = await db.from('device_instances').select('id, org_id').eq('id', body.id).maybeSingle();
  if (findErr) return err(findErr.message, 500);
  if (!row || String(row.org_id) !== String(orgId)) return err('Device not found', 404);

  const { error } = await db.from('device_instances').update(updates).eq('id', body.id);
  if (error) return err(error.message, 500);
  return ok({ id: body.id, ...updates });
}

export const config = { path: '/api/wf/wf4/device' };
