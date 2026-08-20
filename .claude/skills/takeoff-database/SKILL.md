---
name: takeoff-database
description: Use when changing Take-Off Supabase schema, RLS, migrations, projects, plan sets, pages, analyses, device types, device_instances, organization membership, or database write patterns.
---

# Take-Off Database & Persistence

## Role of Supabase

Supabase provides Take-Off's durable application state and authentication-backed data boundary.

Known domain areas include:
- users / organization membership,
- organizations,
- projects,
- plan sets,
- pages,
- analyses / analysis results,
- device types / assemblies,
- `device_instances`,
- manual/reviewed device data where applicable.

Always inspect the current schema/migrations before relying on this list.

## Data ownership model

Most production data is tenant scoped.

The expected ownership chain is conceptually:

```text
Organization
   |
   +--> Users / Memberships
   |
   +--> Projects
          |
          +--> Plan Sets
                 |
                 +--> Pages
                        |
                        +--> Analysis / Processing Results
                        +--> Device Instances
```

Use the actual schema as authoritative.

## Database rules

1. Every tenant-scoped record must have a clear path to an owning organization.
2. RLS must protect tenant-scoped data.
3. Server authorization and RLS should reinforce each other.
4. Do not trust browser-provided ownership fields without verification.
5. Use migrations for schema changes.
6. Do not make undocumented production-only schema changes.
7. Preserve historical/reviewed results when product requirements require reproducibility.
8. Consider concurrency and retries when replacing processing results.

## Before adding a table

Answer:
- What is its primary key?
- Who owns it?
- How is organization ownership established?
- What references it?
- What happens on parent deletion?
- What are its RLS policies?
- Does it need created/updated timestamps?
- Does processing require status/version/attempt fields?
- Does the product need history or only latest state?

## Before adding a column

Determine:
- Is it source data, derived data, processing state, or presentation data?
- Who is allowed to write it?
- Is the server authoritative?
- Is a default/backfill required?
- Does existing code need to handle null during migration?
- Does it need an index?

## Processing persistence

Existing page status is a useful durable boundary.

For production processing, prefer explicit fields where appropriate:

```text
analysis_id
status
processing_version / run_id
attempt_count
last_error
started_at
completed_at
```

Do not add all fields mechanically; add them where they support actual workflow/recovery requirements.

## Device instance replacement

When replacing a page's detected `device_instances`, consider atomicity.

A simple:

```text
DELETE old rows
INSERT new rows
```

can be vulnerable to failures/races.

When modifying this path:
- inspect current behavior,
- consider a transaction/RPC,
- protect against concurrent/stale runs,
- test repeated requests,
- test failure between replacement steps.

## RLS review

For tenant tables, verify all relevant operations:

```text
SELECT
INSERT
UPDATE
DELETE
```

Do not assume SELECT policy implies safe writes.

Add tests for:
- own organization access,
- cross-organization denial,
- anonymous denial,
- role-restricted writes.

## Query performance

Do not optimize speculatively.

When a query becomes important:
- inspect query shape,
- inspect cardinality,
- identify repeated queries/loops,
- add indexes for real filter/join patterns,
- avoid fetching large unbounded result sets,
- paginate/history-limit where needed.

## Reproducibility

For final customer analyses/BOMs, consider whether later configuration changes should alter historical output.

Where reproducibility is required, persist/version the relevant:
- device/assembly definition,
- processing version,
- AI model/prompt configuration,
- reviewed/final result.

Do not silently make historical customer deliverables depend on mutable current configuration.
