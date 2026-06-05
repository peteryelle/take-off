-- Step 1: land the v2 contract.
-- detection_config (per device type) — discover pass writes, detect pass reads.
ALTER TABLE public.device_types
  ADD COLUMN IF NOT EXISTS detection_config jsonb;

COMMENT ON COLUMN public.device_types.detection_config IS
  'v2 detection contract (per device type). Discover writes, detect reads. Shape: {version:2, sources:[schedule|label|symbol], anchor, anchor_mode:exact|regex, uin_pattern, symbol_template, match_tolerance, families:[], cluster_pt, leader_from_anchor, anchor_confidence:high|medium|low, name_source, source:legend|frequency|manual}. name and llm_description remain first-class columns and are NOT duplicated here.';

-- Sheet-level schedule block (shared across types on the sheet).
ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS schedule jsonb;

COMMENT ON COLUMN public.pages.schedule IS
  'Sheet-level schedule block. Shape: {present:bool, locator:text, columns:{uin, detail_sheet, cable_dest:[]}, type_from}. null = no schedule on this sheet (e.g. VA is label-seeded).';
