-- Per-instance audit + leader fields, type-agnostic. Support a user-driven visual
-- audit: the user selects any device(s) on a page, the markup shows the detector's
-- leader evidence, and the user confirms/removes. None of this is a system verdict —
-- has_leader is evidence (NULL = not traced, not "fake"); removed_by_user is the
-- human decision that drives the count.
alter table device_instances add column if not exists has_leader boolean;       -- NULL = leader not traced
alter table device_instances add column if not exists leader_x double precision; -- arrowhead (symbol end of the leader)
alter table device_instances add column if not exists leader_y double precision;
alter table device_instances add column if not exists removed_by_user boolean not null default false;
alter table device_instances add column if not exists audit_note text;           -- optional reviewer note during audit

create index if not exists idx_device_instances_page_audit
  on device_instances(page_id, device_type_id) where removed_by_user = false;
