// netlify/functions/utils/wf4-map.js
// WF4 (floor plans) — the thin mapping layer between the old floor-plan code's
// row shapes and the v2 `takeoff` tables. Detection, routing and confidence
// logic never see this: the WF4 function copies translate at the edge so the
// existing UI and passes keep receiving the shapes they were written for.
//
//   old demarcs          <-> takeoff.tr_pins
//   old manual_devices   <-> takeoff.device_instances (source = 'manual')
//   old page_regions     <-> takeoff.page_regions      (demarc_id <-> tr_pin_id)
//
// Pure functions only — no database access — so they are unit-tested directly
// (tests/test-wf4-map.mjs).
// ─────────────────────────────────────────────────────────────────

import { td } from './takeoff-db.js';

export const EXIT_PIN_RE = /_exit_pg\d+$/;

export const MANUAL_DEVICE_BASIS = 'Placed manually on the plan (detection missed it)';
export const USER_PIN_BASIS = 'TR pin placed on the plan by user';

const nz = (v) => (v === undefined ? null : v);

// ── TR pins ──────────────────────────────────────────────────────

// Kind of pin, from the old demarc's source + name (same rules the old
// pass-demarc dedup used: an exit pin is identified by its name suffix).
export function pinKind(source, name) {
  if (source === 'off_sheet') return 'off_sheet';
  return EXIT_PIN_RE.test(String(name ?? '')) ? 'exit' : 'serving';
}

// Old demarc POST body -> takeoff.tr_pins row (without id).
// `regionId` is only written when the caller supplied it, so a coords-only
// update never nulls an existing schematic link (old behaviour, kept).
export function demarcBodyToPinRow(body, { orgId, userId }) {
  const kind = pinKind(body.source, body.name);
  const placedByUser = body.source === 'user_pin';
  const row = {
    org_id: orgId,
    project_id: body.project_id,
    page_id: nz(body.page_id),
    tr_name: body.name,
    tr_id: nz(body.tr_id),
    pin_kind: kind,
    x_norm: nz(body.x_norm),
    y_norm: nz(body.y_norm),
    stub_ft: body.stub_ft ?? 0,
    note: nz(body.note),
    placement: placedByUser ? 'manual' : 'auto_center',
    source: placedByUser ? 'manual' : 'extracted',
    override_basis: placedByUser ? (body.override_basis || USER_PIN_BASIS) : null,
    entered_by: userId ?? null,
  };
  if (body.region_id !== undefined) row.region_id = body.region_id ?? null;
  if (body.is_primary !== undefined) row.is_primary = !!body.is_primary;
  if (body.node_codes !== undefined) row.node_codes = body.node_codes ?? null;
  return row;
}

// takeoff.tr_pins row -> the demarc shape the old UI and passes read.
export function pinToDemarc(pin) {
  if (!pin) return pin;
  const source = pin.pin_kind === 'off_sheet' ? 'off_sheet'
    : pin.placement === 'manual' ? 'user_pin' : 'auto';
  return {
    id: pin.id,
    project_id: pin.project_id,
    page_id: pin.page_id,
    name: pin.tr_name,
    source,
    x_norm: pin.x_norm,
    y_norm: pin.y_norm,
    stub_ft: pin.stub_ft,
    note: pin.note,
    region_id: pin.region_id,
    is_primary: pin.is_primary,
    node_codes: pin.node_codes,
    x_ft: pin.x_ft,
    y_ft: pin.y_ft,
    created_at: pin.entered_at,
    // v2 extras (ignored by old code)
    tr_id: pin.tr_id,
    pin_kind: pin.pin_kind,
    placement: pin.placement,
  };
}

// ── Page regions ─────────────────────────────────────────────────

export function regionToLegacy(r) {
  if (!r) return r;
  const { tr_pin_id, ...rest } = r;
  return { ...rest, demarc_id: tr_pin_id ?? null };
}

export const REGION_KINDS = ['schematic', 'exclude', 'tr_room'];

// ── Manual devices ───────────────────────────────────────────────

// Old manual-device POST body -> takeoff.device_instances row.
export function manualBodyToInstanceRow(body, { orgId, userId }) {
  return {
    org_id: orgId,
    project_id: body.project_id,
    page_id: body.page_id,
    device_type_id: body.device_type_id,
    x_norm: body.x_norm,
    y_norm: body.y_norm,
    uin: nz(body.uin),
    source: 'manual',
    override_basis: body.override_basis || MANUAL_DEVICE_BASIS,
    detection_method: 'manual',
    confidence: 'high',
    entered_by: userId ?? null,
  };
}

// takeoff.device_instances row -> the manual_devices shape the old UI reads.
export function instanceToManual(d) {
  if (!d) return d;
  return {
    id: d.id,
    page_id: d.page_id,
    device_type_id: d.device_type_id,
    x_norm: d.x_norm,
    y_norm: d.y_norm,
    uin: d.uin,
    added_at: d.entered_at,
  };
}

// ── Device cull state ────────────────────────────────────────────

// `excluded` (v2, read by the BOM) mirrors the old manual_excluded flag.
export function cullUpdate(body) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const u = {};
  if (has('flags')) {
    u.flags = body.flags ?? null;
    u.excluded = Array.isArray(body.flags) && body.flags.includes('manual_excluded');
  }
  if (has('cull_category')) u.cull_category = body.cull_category ?? null;
  if (has('cull_reason')) u.cull_reason = body.cull_reason ?? null;
  return u;
}

// ── Org checks for v2 rows ───────────────────────────────────────

// Returns the page's project_id if the page is in the caller's org, else null.
export async function wfPageProject(supabase, pageId, orgId) {
  if (!pageId) return null;
  const { data, error } = await td(supabase)
    .from('pages').select('project_id').eq('id', pageId).eq('org_id', orgId).maybeSingle();
  return !error && data ? data.project_id : null;
}
