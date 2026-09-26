-- Take-Off v2 — Migration 10: WF4 per-sheet confirmation
-- A plan sheet is confirmed once its setup is done (exclusion areas drawn, TR
-- pin placed). Counting then runs over the confirmed sheets. Changing a
-- sheet's exclusion areas or TR pins afterwards clears the confirmation.

ALTER TABLE takeoff.pages
  ADD COLUMN wf4_ready_at timestamptz,
  ADD COLUMN wf4_ready_by uuid REFERENCES auth.users(id);

-- confirm
SELECT column_name, udt_name FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'pages' AND column_name LIKE 'wf4_ready%';
