-- Store demarc pins in feet too (populated at pin time using the page's
-- ft_per_norm = paper_in * scale_real_ft/scale_paper_in; page 8 = 384 x / 288 y).
-- Lets distance be a pure feet Euclidean between device.x_ft/y_ft and demarc.x_ft/y_ft.
alter table demarcs add column if not exists x_ft double precision;
alter table demarcs add column if not exists y_ft double precision;
