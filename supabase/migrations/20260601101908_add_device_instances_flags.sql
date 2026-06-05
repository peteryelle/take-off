ALTER TABLE public.device_instances ADD COLUMN IF NOT EXISTS flags text[];
COMMENT ON COLUMN public.device_instances.flags IS 'reconcile per-device flags (leader_expanded, leader_unmatched, placement_inferred, no_uin, needs_placement, not_in_schedule, type_conflict). null/empty = clean detection. Written from dev.flags; redo replaces with the page.';
