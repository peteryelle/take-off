ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS route jsonb;

COMMENT ON COLUMN public.pages.route IS
'Per-sheet archetype routing decision, written by discovery (classifySheet) and read by buildDeviceList to route without re-deriving. Shape: {archetype:"device_list"|"quantity_matrix"|"label_stamp"|"unknown", route:"device_list_reader"|"matrix_reader"|"detect_anchor_count"|"review", score:number, reasons:[text], signals:{tableCount:int, anchorTokenCount:int}, classified_at:timestamptz, classifier_version:text}. Distinct from sheet_class (text/geometry CAPABILITY) and schedule (device_list column config). null = not yet classified; buildDeviceList falls back to deriving signals at call time.';
