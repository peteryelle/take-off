ALTER TABLE public.demarcs
  ADD CONSTRAINT demarcs_project_name_key UNIQUE (project_id, name);
COMMENT ON CONSTRAINT demarcs_project_name_key ON public.demarcs IS
  'Supports pass-demarc upsert onConflict(project_id,name). Main demarc is one row per (project,TR name); per-page exit pins encode the page in the name (TR_exit_pgN), so they stay distinct.';
