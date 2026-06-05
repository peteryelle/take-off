-- The detector must capture the full printed UIN (e.g. 'FP-1000A2'), not just the
-- anchor prefix ('FP'). This column holds that captured/parsed UIN so reconcile can
-- exact-match plate -> schedule_rows.uin and distance can pull cable_dest targets.
-- NULL for label-stamp archetype (no UIN) and for bare/annotation chips (FP, FP*),
-- which are flagged, not counted.
alter table device_instances add column if not exists uin text;
create index if not exists idx_device_instances_uin on device_instances(uin);
