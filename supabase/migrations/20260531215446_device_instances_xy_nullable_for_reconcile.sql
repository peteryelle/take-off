-- Reconcile can emit schedule-only devices (no plan label/symbol yet) that must
-- stay visible as needs_placement. Allow null coordinates for those rows.
ALTER TABLE public.device_instances ALTER COLUMN x_norm DROP NOT NULL;
ALTER TABLE public.device_instances ALTER COLUMN y_norm DROP NOT NULL;
