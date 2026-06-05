ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS leader_overrides jsonb;
COMMENT ON COLUMN public.pages.leader_overrides IS 'Per-sheet 1:N leader marks. Array of { type, at:[x,y], quantity, distance_from? }. Updated in place on each run (redo replaces); null = none. reconcile expands each marked cluster to `quantity` device rows positioned at the cluster anchor xy.';
