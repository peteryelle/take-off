-- Canonical "redundant overall sheet" rule for the page-role classifier.
-- A sheet is a redundant overall (composite of enlarged segment sheets, so it would
-- double-count if tallied) when BOTH hold:
--   (1) its title contains "OVERALL", and
--   (2) sibling sheets exist whose drawing number = this sheet's number + a suffix
--       (the enlarged segments, e.g. SE02-01 -> SE02-01AB, SE02-01C, ...).
-- This correctly flags floor overalls (which have segment breakdowns) and leaves
-- standalone overalls (e.g. ROOF, with no segments) counted. It is a SUGGESTION the
-- human confirms in the page-role picker — never an auto-skip.
create or replace view redundant_overall_suggestions as
select
  p.id                       as page_id,
  p.project_id,
  p.pdf_page_number,
  p.drawing_number,
  p.sheet_title,
  count(s.id)                as segment_sibling_count,
  array_agg(s.drawing_number order by s.drawing_number) as segment_siblings,
  'redundant overall — suggest skip (' || count(s.id) || ' segment sheets cover it)' as suggestion
from pages p
join pages s
  on  s.project_id = p.project_id
  and s.id <> p.id
  and p.drawing_number is not null
  and s.drawing_number is not null
  and s.drawing_number like p.drawing_number || '%'
  and length(s.drawing_number) > length(p.drawing_number)
where upper(coalesce(p.sheet_title, '')) like '%OVERALL%'
group by p.id, p.project_id, p.pdf_page_number, p.drawing_number, p.sheet_title;
