alter table public.pages add column if not exists page_role text;

comment on column public.pages.page_role is
  'Human-assigned page role: plan|schedule|legend|detail|skip. Source of truth is the thumbnail/assignment UI (no auto-classifier in the authoritative path). Drives the batch runner per-page work: plan->detect+symbol, schedule->schedule reader, legend|detail|skip->no counting.';
