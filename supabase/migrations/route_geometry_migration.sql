-- Adds route persistence to device_instances, per the explicit decision
-- earlier in this project: distances were already persisted (total_ft,
-- run_length_ft), but the route itself was deliberately ephemeral
-- (recomputed fresh every batch run, never stored) — fine for Tier 1
-- waypoint routing, where a bad route is obvious just by looking at the
-- page. Tier 3's failure modes are much harder to eyeball (a wall-aware
-- route through misdetected geometry doesn't look obviously wrong), so if a
-- distance looks suspicious later, there needs to be a record of what
-- geometry produced it, not just the number.
alter table device_instances
  add column if not exists route_geometry jsonb,       -- [[x,y],...] simplified route points, page-point space
  add column if not exists routed_via_tier3 boolean not null default false;

comment on column device_instances.route_geometry is
  'Simplified route waypoints from buildPageRouter (Tier 3) or buildGreedyPath (Tier 1), page-point space. Null if routing failed or was never attempted (e.g. device has no demarc pin).';
comment on column device_instances.routed_via_tier3 is
  'True if this device''s total_ft/run_length_ft came from wall-aware Tier 3 routing (public/lib/wall-aware-path.js). False means Tier 1 (waypoint) routing, whether by fallback or because no wall calibration was confirmed for this project.';
