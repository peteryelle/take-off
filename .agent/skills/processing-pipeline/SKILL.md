---
name: takeoff-processing-pipeline
description: Use when modifying Take-Off PDF/page analysis, public/lib/pipeline.js, pass-* Netlify Functions, Anthropic processing, page status, device instance persistence, retries, or concurrency.
---

# Take-Off Processing Pipeline

## Mental model

Take-Off uses a mixed orchestration model:

```text
PDF / Plan Set
      |
      v
Browser workflow orchestration
`public/multi-page.html`
`public/lib/pipeline.js`
      |
      v
Netlify `pass-*` functions
      |
      +--> authorization
      +--> image processing
      +--> Anthropic
      +--> normalization/domain processing
      |
      v
Supabase
      |
      +--> page status
      +--> analysis fields
      +--> device_instances
      v
BOM / review workflow
```

Heavy AI/image processing is already server-side. Do not incorrectly move it to the browser.

## Relevant processing areas

Examples include:
- `netlify/functions/pass-batch.js`
- `pass-discover.js`
- `pass-extract.js`
- `pass-describe.js`
- `pass-visual-augment.js`
- other `pass-*` handlers
- `netlify/functions/utils/strips.js`
- `public/lib/pipeline.js`
- domain modules under `public/lib/`

Search current code before assuming exact stage ordering.

## Existing durability

Per-page processing state already exists. `pass-batch.js` has been observed persisting states such as:
- `running`
- `done`
- error state

Build on this rather than replacing it.

## Processing invariants

1. A successful page should not be lost because another page fails.
2. Reprocessing must not create duplicate logical results.
3. A stale processing run must not overwrite a newer valid run.
4. Concurrency must be bounded.
5. Provider retries must be bounded.
6. `429`, timeout, transient `5xx`, and malformed AI output require explicit handling.
7. Successful work should be persisted as early as safely possible.
8. The browser should not be the sole source of truth for processing state.
9. Processing status shown to users must come from durable state.
10. Preserve authorization before authoritative page/project writes.

## Idempotency

`pass-batch.js` has used a delete-then-insert replacement pattern for `device_instances`.

When changing this area, consider:
- concurrent processing of the same page,
- insert failure after deletion,
- successful server completion followed by lost response,
- browser retry,
- stale run completing after a newer run.

Prefer a design with identifiers such as:

```text
analysis_id
page_id
processing_version or run_id
attempt
```

Where feasible, make result replacement atomic/transactional.

## Concurrency

Do not introduce unbounded `Promise.all()` over arbitrary pages/strips.

Use a clear concurrency limit.

When changing concurrency, evaluate:
- number of pages,
- calls per page,
- Anthropic rate limits,
- Netlify execution/concurrency,
- database writes,
- cost.

## Retry ownership

Avoid retry multiplication.

Bad:

```text
browser retries
  x function retries
  x provider helper retries
```

Define which layer owns each retry and cap total attempts.

Use backoff for transient/provider rate-limit failures. Do not blindly retry permanent validation/authorization failures.

## Analysis-level evolution

The PROD direction is to introduce durable analysis-level state above existing page state:

```text
Analysis
├── Page 1 complete
├── Page 2 processing
├── Page 3 retrying
└── Page 4 queued
```

When implementing this, extend existing page persistence and `pass-*` behavior incrementally. Do not require a wholesale processing rewrite.

Desired user behavior:
- start analysis,
- leave/refresh,
- return,
- see durable progress,
- retry only failed work.

## Before changing a processing stage

Document:
1. Input.
2. Output.
3. Persisted fields affected.
4. External services called.
5. Authorization required.
6. Failure behavior.
7. Retry behavior.
8. Whether rerunning is safe.
9. Upstream/downstream stages affected.

Add or update tests for failure and rerun behavior, not only the happy path.
