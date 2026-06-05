-- Device-list archetype store: one row per scheduled device (UIN), with its detail
-- reference and cable destination(s). For sheets that carry a schedule (e.g. QTS
-- SE02-01AB DETAIL SCHEDULE on page 8), this is the AUTHORITATIVE device list and
-- count; plan labels reconcile against these UINs. cable_dest_* are the demarc/TR
-- targets the distance step routes each device to.
create table if not exists schedule_rows (
  id            bigint generated always as identity primary key,
  project_id    bigint not null,
  page_id       bigint not null references pages(id) on delete cascade,
  schedule_name text,
  uin           text not null,
  device_prefix text,                 -- type code, split_part(uin,'-',1)
  detail_num    text,
  detail_sheet  text,
  cable_dest_1  text,
  cable_dest_2  text,
  created_at    timestamptz not null default now(),
  unique (project_id, uin)
);
create index if not exists idx_schedule_rows_page on schedule_rows(page_id);
create index if not exists idx_schedule_rows_prefix on schedule_rows(project_id, device_prefix);
