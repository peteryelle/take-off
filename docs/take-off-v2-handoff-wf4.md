# Take-Off v2 — handoff for WF4 (floor plans)

Paste or upload this file at the start of the new chat, together with a fresh zip of the repo.

## How we work
- **Design first, then code.** Mock up when a step's screen is new; code only after Peter approves.
- **No metered API/LLM calls without Peter's explicit approval** (cost). Deterministic work (pdf.js text/vector reading) runs in the browser at no cost.
- **Database:** Supabase project **Take-off** (`lpjpqmpjxtwsnakcwqvb`, production). Claude may apply migrations and run read-only SQL through the Supabase connector; test inserts are done inside `BEGIN … ROLLBACK`. Every migration is also saved as a repo file.
- **Delivery:** each step ships as a zip with repo paths. Peter runs `cd ~/take-off && unzip -o ~/Downloads/<name>.zip`, the test command, then `git add … && git commit && git push` (Netlify deploys `main`). Files placed by hand have landed in wrong folders — always unzip from the repo root.
- **Tests:** `node tests/<name>.mjs`; fixtures live in the **root `fixtures/` folder**. Every engine change is checked against real EHRM drawings.
- **The BOM is output only.** Nothing is read from a BOM workbook into the app. Quantities come from drawings or manual entry in the app; parts and prices from the parts catalog; rules from the sheets' notes.

## Architecture (built so far)
- **Schema:** all v2 tables are in Postgres schema **`takeoff`** (exposed in the Data API). Old app tables stay in `public` untouched until final cleanup. RLS on every table: `org_id = public.auth_org_id()`. Functions use the service key and check the org via `assertWfProjectInOrg` (`netlify/functions/utils/takeoff-db.js`, `td(supabase)` = `supabase.schema('takeoff')`).
- **Provenance on every module row:** `source` (extracted | edited | manual | imported), `sheet_revision_id`, `original_value`, `override_basis` (required for edited/manual — enforced by a CHECK), `entered_by/at`, `conflict`.
- **TR references without WF2:** tables store `tr_name` (text) + nullable `tr_id`; `wf-wf2.js` links names to `trs` on save using `resolveTrMatch` (handles `EB51A` vs `EB51A-1`).
- **Storage:** bucket `schematics`, path `v2/{project_id}/{document_id}-{filename}` (never overwrites).
- **Steps are a recommended order, never a lock** (`public/lib/wf-steps.js`). Any step can be used alone; the BOM generates with whatever is in scope.
- **Device libraries are per project** by default; "copy from a previous project" brings types in as `verified = false` (must be re-checked on the new set before counting).

## Done and deployed
| Step | Page / API | Notes |
|---|---|---|
| WF0 | `wf-projects.html`, `wf-project.html`, `/api/wf/projects` | create project + 8 steps + own library; scope; confirm/reopen/touch |
| Shared intake | `lib/wf-intake-ui.js`, `/api/wf/documents` | multi-PDF upload, title-block reading (`lib/title-block.js`, 52 tests on real EHRM title blocks), duplicates by split-independent text fingerprint, revisions pending until accepted, pin reference, rules found at upload |
| WF1 | `wf1.html`, `/api/wf/wf1` | legend = reference only; line types; notes & rules (`lib/note-rules.js`: T-001 note 28 = 100'/180° inside, T-108 note 1 = 250'/180° OSP; T-002 phasing sheet referenced but not in the set) |
| WF2 | `wf2.html`, `/api/wf/wf2` | reuses repo T-500 reader; 45 TRs on the real sheet; five columns only (bldg, level, TR, Cat6A terminations, patch panels); revision compare |
| WF3 | `wf3.html`, `/api/wf/wf3`, `lib/osp-extract.js` | JS port of `extract_conduit.py`, identical to the Python on T-108 (29 segments, 35 callouts, 20 discrepancies, all take-off rows); limits from WF1 rules; `runOsp()` reports what it can't recognise; overlay with click-to-focus; corrections with reason. Test: `tests/test-osp-extract.mjs` (17 checks) with `fixtures/t108-osp-input.json` + the Python's CSVs |

Migrations (in `supabase/migrations/`): `20260925100000_takeoff_v2_core`, `…110000_modules`, `…120000_libraries`, `…121000_library_scope`, `…130000_bom`, `20260926100000_takeoff_v2_osp_runs`.

## WF4 plan (agreed)
**Option C — move the existing floor-plan tools over with minimal changes.**
- Add the missing tables to `takeoff` in their existing shape (page regions, discovery sessions/clusters/results; wall calibration and waypoints only if Routed is kept).
- Make WF4 copies of the needed functions changed only to use the `takeoff` schema and v2 page/project ids. Detection, routing and confidence logic unchanged. Old app untouched.
- Shared `public/lib/` logic (geometry, leader tracing, waypoint path, stitch-runs) is schema-free and reused as-is.

Old pipeline inventory (functions → old tables): `pass-discover` (device_types, discovery_*), `pass-symbol`, `pass-b-page`, `pass-demarc` (demarcs, page_regions, device_instances), `pass-batch` (device_instances, device_types, manual_devices, page_regions, page_wall_geometry, schedule_rows, wall_calibrations, waypoints), `pass-waypoint`, `pass-wall-calibrate`, `page-regions`, `device-instance`, `manual-device`, `takeoff-summary`, `set-page-role`. UI today lives in `multi-page.html` (6,557 lines) and `discover.html`.

**Routing modes (new decision):** per project with per-sheet override —
- **Straight line** (default): device → TR pin, multiplier default **100%**.
- **Right-angle**: horizontal + vertical legs, no setup.
- **Routed**: today's wall/waypoint routing (optional; move over later or leave out).
Mode + multiplier are written to the BOM's Notes & Assumptions.

**WF4 stages (per the mockup):**
1. Sheets (intake, already built) + **Device library**: Discover crop tool — label read (e.g. "DD2") or 3-instance shape signature, legend only suggests names; copied types must be verified.
2. **TR pins**: pick TR from the WF2 list, or type it; auto-placed at room centre, movable.
3. **Count & route**: cost estimate and approval before any metered run; unchanged pages (same fingerprint as reference) reused free.
4. **Review**: counts by level, cable lengths (with multipliers), per-page confidence map (exclude/add device, isolate path).
Metered (LLM) passes to gate: Discover, demarc scan (Pass B), symbol detection, batch run.

## Open items
- Phasing (T-002): does it split BOM quantities? Not answered; `pages.phase` exists.
- Change-order pricing default (bid vs current): per-project setting exists, default bid.
- Labor: `parts.labor_min` column instead of a separate labor table (flagged, not confirmed).
- WF3: other zone sheets (T-101–T-107) not yet checked against expectations; drawing conventions (colors, MH/HH labels, callout pattern) to become per-project settings as new AE sets arrive.
- Not yet built: WF5 (TR rooms), WF6 (rack & details from T-501 coded notes), WF7 (riser + T-601 allowances), WF8 (BOM fill/review/generate, snapshots, change orders).
