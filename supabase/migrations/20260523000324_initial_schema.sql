
-- ─────────────────────────────────────────────────────────────────
-- Take-off — Schematic Device Analyzer Pipeline Schema
-- ─────────────────────────────────────────────────────────────────

-- ── PROJECTS ──────────────────────────────────────────────────────
CREATE TABLE projects (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    number        TEXT,
    client        TEXT,
    pdf_filename  TEXT,
    storage_path  TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── DEVICE TYPES (from Pass A legend) ────────────────────────────
CREATE TABLE device_types (
    id            BIGSERIAL PRIMARY KEY,
    project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    legend_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    category      TEXT,
    discipline    TEXT,
    notes         TEXT,
    UNIQUE (project_id, legend_id)
);

-- ── PAGES (one row per PDF page, Pass B) ─────────────────────────
CREATE TABLE pages (
    id                BIGSERIAL PRIMARY KEY,
    project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pdf_page_number   INTEGER NOT NULL,
    drawing_number    TEXT,
    sheet_title       TEXT,
    building          TEXT,
    level             TEXT,
    area              TEXT,
    scale_label       TEXT,
    scale_paper_in    NUMERIC(10,6),
    scale_real_ft     NUMERIC(10,4),
    demarc_label      TEXT,
    demarc_type       TEXT CHECK (demarc_type IN ('MDF','IDF','NID','handhole','panel','backboard','off_sheet','other')),
    demarc_x          NUMERIC(6,4),
    demarc_y          NUMERIC(6,4),
    demarc_source     TEXT CHECK (demarc_source IN ('claude','user_pin','off_sheet')),
    image_raw_path    TEXT,
    image_annotated_path TEXT,
    pass_b_complete   BOOLEAN DEFAULT FALSE,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, pdf_page_number)
);

-- ── DETECTION RUNS (one row per Pass C execution) ─────────────────
CREATE TABLE detection_runs (
    id                  BIGSERIAL PRIMARY KEY,
    page_id             BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    device_type_id      BIGINT NOT NULL REFERENCES device_types(id) ON DELETE CASCADE,
    total_count         INTEGER,
    duplicates_removed  INTEGER DEFAULT 0,
    strip_count         INTEGER,
    dedup_threshold     NUMERIC(5,3),
    longest_run_ft      NUMERIC(10,1),
    shortest_run_ft     NUMERIC(10,1),
    annotated_image_path TEXT,
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    elapsed_sec         NUMERIC(8,1),
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── DETECTIONS (one row per device instance found) ────────────────
CREATE TABLE detections (
    id                  BIGSERIAL PRIMARY KEY,
    run_id              BIGINT NOT NULL REFERENCES detection_runs(id) ON DELETE CASCADE,
    page_id             BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    device_type_id      BIGINT NOT NULL REFERENCES device_types(id) ON DELETE CASCADE,
    detection_label     TEXT,
    location_label      TEXT,
    x                   NUMERIC(6,4),
    y                   NUMERIC(6,4),
    source_strip        INTEGER,
    path_length_norm    NUMERIC(8,4),
    path_length_ft      NUMERIC(10,1),
    confidence          TEXT CHECK (confidence IN ('high','medium','low')),
    flagged             BOOLEAN DEFAULT FALSE,
    flag_reason         TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ───────────────────────────────────────────────────────
CREATE INDEX idx_pages_project       ON pages(project_id);
CREATE INDEX idx_detections_page     ON detections(page_id);
CREATE INDEX idx_detections_device   ON detections(device_type_id);
CREATE INDEX idx_detections_run      ON detections(run_id);
CREATE INDEX idx_detections_flagged  ON detections(flagged) WHERE flagged = TRUE;
CREATE INDEX idx_detections_path_ft  ON detections(path_length_ft);

-- ── VIEWS ─────────────────────────────────────────────────────────

-- Per-page device summary
CREATE VIEW v_page_summary AS
SELECT
    p.drawing_number,
    p.sheet_title,
    p.building,
    p.level,
    dt.legend_id,
    dt.name                             AS device_name,
    COUNT(d.id)                         AS count,
    MIN(d.path_length_ft)               AS shortest_ft,
    MAX(d.path_length_ft)               AS longest_ft,
    ROUND(AVG(d.path_length_ft), 0)     AS avg_ft,
    SUM(d.path_length_ft)               AS total_ft
FROM detections d
JOIN pages p          ON d.page_id        = p.id
JOIN device_types dt  ON d.device_type_id = dt.id
GROUP BY p.id, p.drawing_number, p.sheet_title, p.building, p.level, dt.id, dt.legend_id, dt.name;

-- Full project rollup (takeoff summary)
CREATE VIEW v_project_rollup AS
SELECT
    pr.name                             AS project_name,
    dt.legend_id,
    dt.name                             AS device_name,
    COUNT(d.id)                         AS total_count,
    MIN(d.path_length_ft)               AS shortest_ft,
    MAX(d.path_length_ft)               AS longest_ft,
    ROUND(AVG(d.path_length_ft), 0)     AS avg_ft,
    ROUND(SUM(d.path_length_ft), 0)     AS total_cable_ft,
    COUNT(DISTINCT d.page_id)           AS sheets_with_device
FROM detections d
JOIN pages p          ON d.page_id        = p.id
JOIN projects pr      ON p.project_id     = pr.id
JOIN device_types dt  ON d.device_type_id = dt.id
GROUP BY pr.id, pr.name, dt.id, dt.legend_id, dt.name;

-- TIA violations — runs exceeding 295 ft permanent link limit
CREATE VIEW v_tia_violations AS
SELECT
    p.drawing_number,
    p.sheet_title,
    p.building,
    p.level,
    dt.name                 AS device_name,
    d.detection_label,
    d.location_label,
    ROUND(d.path_length_ft, 0) AS run_ft,
    d.confidence
FROM detections d
JOIN pages p         ON d.page_id        = p.id
JOIN device_types dt ON d.device_type_id = dt.id
WHERE d.path_length_ft > 295
ORDER BY d.path_length_ft DESC;

-- Flagged detections needing review
CREATE VIEW v_flagged AS
SELECT
    p.drawing_number,
    p.sheet_title,
    dt.name         AS device_name,
    d.detection_label,
    d.location_label,
    d.confidence,
    d.flag_reason,
    d.created_at
FROM detections d
JOIN pages p         ON d.page_id        = p.id
JOIN device_types dt ON d.device_type_id = dt.id
WHERE d.flagged = TRUE
ORDER BY p.pdf_page_number;

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────
ALTER TABLE projects      ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_types  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE detection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE detections    ENABLE ROW LEVEL SECURITY;
