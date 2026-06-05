ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_library   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS library_name text;

COMMENT ON COLUMN public.projects.is_library IS
  'When true, this project is a reusable device-type library. New projects seed their device types from it via copy-from-project (copy-in: independent after copy). AE name and associated-project links deferred.';
COMMENT ON COLUMN public.projects.library_name IS
  'Optional display name for the library (falls back to projects.name when null).';
