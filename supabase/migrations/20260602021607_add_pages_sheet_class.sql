ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS sheet_class jsonb;

COMMENT ON COLUMN public.pages.sheet_class IS
'Ingest probe result (passive annotation; no pipeline branch reads it yet). Shape: {text_layer:bool, geometry:bool, class:"vector_text"|"vector_geometry"|"vector_text_geometry"|"raster_only", text_chars:int, path_ops:int, raster_images:int, probed_at:timestamptz}. text_layer = usable pdf.js getTextContent; geometry = usable vector path ops from getOperatorList. raster_only = both false. Splits LOCATION/CLASSIFICATION routing per the 2x2 of text x geometry. null = not yet probed.';
