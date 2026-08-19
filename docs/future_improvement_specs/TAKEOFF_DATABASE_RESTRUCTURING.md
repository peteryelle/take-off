# Take-Off Database Restructuring Guide

## Purpose

Define the recommended table enhancements for Take-Off. The database should remain clear, normalized, auditable, and easy for humans and AI agents to understand.

## Core Architecture

Separate data into four layers:

```text
SOURCE DATA
documents, pages, detections, schedule rows
        |
        v
AUTHORITATIVE DOMAIN DATA
projects, device instances, demarcs, regions
        |
        v
CONFIGURATION
device libraries, device types, detection configs, assemblies
        |
        v
DERIVED OUTPUT
BOMs, TIA violations, summaries
```

**Critical rule:** `device_instances` is the authoritative inventory of devices in a project. Raw detections and other extraction results feed into it; BOM, routing, counts, and reporting consume it.

## Recommended Changes

| Area | Recommendation | Priority |
|---|---|---|
| `projects` | Stop using projects as device libraries | High |
| `pages` / `project_pages` | Clarify source pages vs project working pages | High |
| `manual_devices` | Consider merging into `device_instances` using provenance | High |
| `device_types` | Separate device definition from detection configuration | Medium |
| `bom_items` | Add `bom_runs` for versioned BOM output | Medium |
| `profiles` | Add memberships only if users can belong to multiple orgs | Conditional |
| `waypoints` | Keep simple until routing requires a graph | Low |

## 1. Separate Projects and Device Libraries

A `project` should always represent an actual takeoff project.

Instead of using a special project as a reusable library:

```text
organizations
├── projects
└── device_libraries
     └── device_types
```

Recommended new table:

```text
device_libraries
- id
- organization_id
- name
- description
- created_at
- updated_at
```

This prevents `projects` from representing two unrelated lifecycles.

## 2. Clarify Documents and Pages

If uploaded PDF pages can be reused or selected into project working sets, use:

```text
source_documents
      |
      +-- source_pages
              |
              +-- project_pages
                      |
                      +-- projects
```

Responsibilities:

- `source_documents`: uploaded PDF/file metadata.
- `source_pages`: physical pages/sheets from the document.
- `project_pages`: pages selected and ordered for a project's working set.

If a page can only ever belong to one project, simplify instead: store `project_id` directly on `pages` and remove `project_pages`.

## 3. Simplify Manual Devices

A manually placed device is still a project device. Consider eliminating `manual_devices` as a separate authoritative table.

Use:

```text
device_instances
- id
- project_id
- page_id
- device_type_id
- source_type
- source_detection_id
- created_by
- ...
```

Possible `source_type` values:

```text
DETECTION
MANUAL
DISCOVERY
IMPORTED
```

Manual example:

```text
source_type = MANUAL
source_detection_id = NULL
```

Automated reconciliation must never silently delete or overwrite manual authoritative devices.

## 4. Preserve Detection History

Keep the existing separation:

```text
detection_runs
      |
      +-- detections
              |
              v
        reconciliation
              |
              v
       device_instances
```

- `detection_runs`: one detector execution, including status, timing, model/config version, counts, and errors.
- `detections`: immutable/raw model output including coordinates and confidence.
- `device_instances`: reconciled project truth.

**Rule:** detections are evidence; device instances are authoritative state.

## 5. Separate Device Definition from Detection Configuration

Avoid making `device_types` responsible for both the business concept and AI configuration.

Use:

```text
device_types
      |
      +-- device_detection_configs
```

`device_types` stores stable information such as name, label, category, ports, and symbol identity.

`device_detection_configs` stores model/version, thresholds, template references, and detector configuration.

This allows detection configuration to evolve without redefining the device itself.

## 6. Make Demarc and Region Relationships Explicit

Recommended:

```text
project
  |
  +-- demarcs
        |
        +-- device_instances
```

Use explicit `demarc_id` relationships rather than inferring assignments from names or coordinates.

Keep `page_regions`, but use an explicit type such as:

```text
TR_SERVICE
EXCLUDE
INCLUDE
ROOM
DETECTION_SCOPE
```

TR-serving regions should reference their associated `demarc_id`.

## 7. Treat Schedule Rows as Source Data

`schedule_rows` should represent what was extracted from the drawing.

```text
drawing schedule
      |
      v
schedule_rows
      |
      v
matching / reconciliation
      |
      v
device_instances
```

Do not allow parsed schedule rows to become a second authoritative device inventory.

## 8. Keep Discovery as a Workflow

Current structure is appropriate:

```text
discovery_sessions
      |
      +-- discovery_clusters
      |
      +-- discovery_results
```

When approved, a discovery result should create or reference a real `device_type`.

```text
discovery_result
      |
      | approved
      v
device_type
```

Avoid having `discovery_results` and `device_types` permanently represent the same approved definition.

## 9. Version BOM Generation

Keep:

```text
assembly_templates
      |
      +-- assembly_parts
```

Add:

```text
bom_runs
   |
   +-- bom_items
```

Suggested `bom_runs` fields:

```text
id
project_id
status
created_at
created_by
completed_at
```

This preserves BOM history instead of overwriting previous generated results.

## 10. Profiles and Organizations

The current model is sufficient if:

```text
one user -> one organization
```

If users must belong to multiple organizations, introduce:

```text
profiles
    |
    +-- organization_memberships
              |
              +-- organizations
```

Do not add this complexity unless multi-organization membership is required.

## 11. Keep Waypoints Simple

Keep `waypoints` as-is unless routing becomes complex.

If graph-based routing is eventually required, evolve toward:

```text
routing_nodes
      |
      +-- routing_edges
```

Do not introduce a routing graph prematurely.

## 12. Reporting Views

Continue using views such as:

```text
v_project_summary
v_demarc_summary
v_tia_violations
```

Prefer deriving summaries from authoritative tables instead of duplicating totals on parent records.

## Recommended Target Model

```text
organizations
│
├── profiles / organization_memberships
│
├── projects
│   ├── project_pages
│   │      └── source_pages
│   │             └── source_documents
│   ├── page_regions
│   ├── demarcs
│   ├── waypoints
│   ├── detection_runs
│   │      └── detections
│   ├── device_instances
│   ├── schedule_rows
│   ├── discovery_sessions
│   │      ├── discovery_clusters
│   │      └── discovery_results
│   └── bom_runs
│          └── bom_items
│
├── device_libraries
│      └── device_types
│             └── device_detection_configs
│
└── assembly_templates
       └── assembly_parts
```

## Relationship Rules

1. Every table must have one clear responsibility.
2. Use explicit foreign keys for ownership and relationships.
3. Do not store the same authoritative fact in multiple tables.
4. Keep raw AI/extraction output separate from authoritative domain state.
5. Use run/batch parent tables when generated output requires history.
6. Prefer foreign keys over inferring relationships from names or coordinates.
7. Use unique constraints to prevent invalid domain duplicates.
8. Review indexes for common foreign-key and query paths.
9. Review delete/cascade behavior before adding foreign keys.
10. Every tenant-owned relationship must be reviewed for RLS and organization isolation.

## Implementation Priority

### Phase 1 — Remove ambiguity

Focus on:

```text
projects vs device libraries
pages vs project_pages
manual_devices vs device_instances
```

### Phase 2 — Improve versioning

Add or evaluate:

```text
device_detection_configs
bom_runs
```

### Phase 3 — Strengthen integrity

Audit:

```text
foreign keys
unique constraints
indexes
ON DELETE behavior
RLS policies
organization ownership
```

### Phase 4 — Optional

Only when required:

```text
organization_memberships
routing graph
additional run/version tables
```

## AI Implementation Rules

```yaml
database_architecture:
  authoritative_device_table: device_instances

  principles:
    - one_table_one_responsibility
    - do_not_duplicate_authoritative_state
    - prefer_explicit_foreign_keys
    - preserve_raw_detection_history
    - preserve_manual_device_changes
    - use_run_tables_for_versioned_generated_output
    - separate_projects_from_device_libraries
    - review_rls_for_tenant_owned_relationships
    - avoid_complexity_without_a_domain_requirement

  before_restructuring:
    - inspect_existing_schema
    - inspect_foreign_keys
    - inspect_unique_constraints
    - inspect_indexes
    - inspect_rls_policies
    - inspect_application_dependencies
    - inspect_existing_migrations
    - account_for_existing_data

  safety:
    - do_not_drop_tables_without_dependency_review
    - do_not_drop_columns_without_dependency_review
    - do_not_merge_tables_without_data_migration_plan
    - do_not_modify_deployed_migrations
```

## Final Rule

The database should maintain this directional flow:

```text
RAW INPUT
   |
   v
RECONCILIATION
   |
   v
AUTHORITATIVE DOMAIN STATE
   |
   v
DERIVED OUTPUT
```

Do not allow raw extraction tables, workflow tables, or generated-output tables to become competing sources of truth.
