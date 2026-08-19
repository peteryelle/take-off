# Server-Owned Analysis Jobs

## Objective

Move long-running Take-Off analysis out of the browser.

The browser must only **create a job and observe its status**. A server worker owns execution. Supabase stores durable job state so analysis continues if the browser closes or refreshes.

## Architecture

```text
Browser
  |
  | create job
  v
Server API
  |
  | INSERT
  v
analysis_jobs (Supabase)
  |
  | claim queued job
  v
Server Worker
  |
  | execute + update progress
  v
Analysis Pipeline
  |
  +--> detection_runs
  +--> detections
  +--> device_instances
  |
  v
analysis_jobs.status = completed
```

## 1. Create `analysis_jobs`

Add a Supabase migration for:

```sql
create table public.analysis_jobs (
    id uuid primary key default gen_random_uuid(),

    organization_id uuid not null
        references public.organizations(id),

    project_id uuid not null
        references public.projects(id)
        on delete cascade,

    page_id uuid
        references public.pages(id)
        on delete cascade,

    job_type text not null,

    status text not null default 'queued'
        check (status in (
            'queued',
            'running',
            'completed',
            'failed',
            'cancelled'
        )),

    progress_percent integer not null default 0
        check (progress_percent between 0 and 100),

    current_step text,

    attempt_count integer not null default 0,

    payload jsonb not null default '{}'::jsonb,
    result jsonb,

    error_message text,

    created_by uuid
        references public.profiles(id),

    created_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    failed_at timestamptz,
    updated_at timestamptz not null default now()
);
```

Add indexes:

```sql
create index analysis_jobs_project_id_idx
    on public.analysis_jobs(project_id);

create index analysis_jobs_status_idx
    on public.analysis_jobs(status);

create index analysis_jobs_queued_idx
    on public.analysis_jobs(created_at)
    where status = 'queued';
```

Add appropriate RLS policies using the project's existing organization/tenant authorization model.

## 2. Job Types

Use one job table for server-owned analysis workflows.

Initial examples:

```text
page_detection
project_detection
device_discovery
schedule_extraction
routing_analysis
bom_generation
```

Do not create a separate job table for each analysis type.

## 3. Job Lifecycle

Allowed transitions:

```text
queued
  |
  v
running
  |
  +--> completed
  +--> failed
  +--> cancelled
```

Worker behavior:

1. Atomically claim one `queued` job.
2. Set `status = 'running'`.
3. Set `started_at`.
4. Increment `attempt_count`.
5. Execute the requested analysis.
6. Update `current_step` and `progress_percent` at meaningful milestones.
7. Write results to the appropriate domain tables.
8. Set `status = 'completed'`, `progress_percent = 100`, and `completed_at`.

On failure:

```text
status = failed
failed_at = now()
error_message = sanitized failure message
```

## 4. Atomic Job Claiming

Two workers must never process the same job.

Implement a Postgres function such as:

```text
claim_next_analysis_job()
```

The function must atomically select and claim a queued job using row locking:

```sql
FOR UPDATE SKIP LOCKED
```

Do not implement worker claiming as separate unprotected `SELECT` then `UPDATE` operations.

## 5. Browser Responsibilities

When the user starts analysis:

```text
Browser
  |
  | POST start-analysis
  v
Server
  |
  | create analysis_jobs row
  v
Return job_id immediately
```

The browser must **not execute or own the long-running analysis**.

The browser should:

- create the job through a server endpoint
- receive `job_id`
- display job status
- poll or subscribe for progress
- reload existing job state after refresh/navigation

V1 may poll every 2–5 seconds.

Supabase Realtime may replace polling later.

## 6. Worker Responsibilities

The worker is responsible for:

```text
claim job
validate payload
execute analysis
update progress
persist domain results
mark completed/failed
```

The worker may be implemented using the project's existing server infrastructure.

Do not couple `analysis_jobs` to a specific worker platform. The durable Supabase job table must remain valid if the worker implementation changes later.

## 7. Progress Updates

Update progress only at meaningful stages.

Example:

```text
5%   preparing
15%  loading drawing
25%  analyzing page
60%  detecting devices
75%  reconciling detections
90%  saving results
100% completed
```

`current_step` should contain a short user-facing description.

Do not continuously write insignificant percentage changes.

## 8. Domain Data Boundaries

`analysis_jobs` tracks **execution state**, not analysis domain data.

Maintain these responsibilities:

```text
analysis_jobs
= server job execution/progress

detection_runs
= detector execution metadata

detections
= raw detector output

device_instances
= authoritative project devices
```

Do not store full detection results in `analysis_jobs.result`.

`result` may contain small references or summaries:

```json
{
  "detection_run_id": "<uuid>",
  "devices_found": 82
}
```

## 9. Connect Detection Runs to Jobs

Add a nullable relationship:

```text
detection_runs.analysis_job_id
    -> analysis_jobs.id
```

This creates traceability:

```text
analysis_jobs
      |
      v
detection_runs
      |
      v
detections
      |
      v
device_instances
```

Use a migration; do not modify previously deployed migrations.

## 10. Payload

`payload` contains the immutable request parameters needed by the worker.

Example:

```json
{
  "page_id": "<uuid>",
  "device_type_ids": ["<uuid>", "<uuid>"],
  "force_reanalysis": false
}
```

Validate payload server-side before execution.

Do not store secrets in `payload`.

## 11. Reliability Rules

The implementation must satisfy:

```yaml
analysis_jobs:
  durable_state: supabase
  execution_owner: server_worker
  browser_role: submit_and_observe

  requirements:
    - analysis_survives_browser_close
    - atomic_job_claiming
    - no_duplicate_worker_execution
    - durable_progress
    - durable_failure_state
    - tenant_safe_rls
    - domain_results_stored_in_domain_tables
    - worker_platform_independent

  source_of_truth:
    execution_state: analysis_jobs
    raw_detection_output: detections
    authoritative_devices: device_instances
```

## 12. Implementation Order

Implement in this order:

1. Create `analysis_jobs` migration.
2. Add indexes and RLS policies.
3. Implement `claim_next_analysis_job()`.
4. Add `detection_runs.analysis_job_id`.
5. Create server endpoint to enqueue a job.
6. Implement server worker.
7. Move existing browser-owned analysis logic into the worker.
8. Add progress updates.
9. Update frontend to create jobs instead of running analysis.
10. Add frontend polling every 2–5 seconds.
11. Restore active job state when the page reloads.
12. Test browser-close/reopen behavior.
13. Test two workers attempting to claim jobs concurrently.
14. Test failure and retry behavior.

## Acceptance Criteria

The task is complete when:

- Starting analysis creates an `analysis_jobs` row with `queued` status.
- The API returns a `job_id` without waiting for analysis completion.
- A server worker atomically claims the job.
- Analysis continues after the initiating browser tab closes.
- Progress is persisted in Supabase.
- Refreshing/reopening the UI restores current progress.
- Successful analysis ends with `completed` and `100%`.
- Failed analysis ends with `failed` and a useful error state.
- Two workers cannot execute the same job simultaneously.
- Detection output remains in existing detection/domain tables.
- `device_instances` remains the authoritative device inventory.
- RLS prevents cross-organization job access.
- Database changes are implemented through new Supabase migrations.

## Future Upgrade

Do **not** add a separate queue in V1.

If worker volume later requires stronger queue semantics, add Supabase Queues/PGMQ behind the existing job ledger:

```text
analysis_jobs
      |
      v
durable queue
      |
      v
worker pool
```

`analysis_jobs` should remain the user-visible source of truth for job status even if queue infrastructure changes.
