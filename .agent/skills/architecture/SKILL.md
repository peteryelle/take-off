---
name: takeoff-architecture
description: Use when changing repository structure, deciding where new Take-Off code belongs, adding endpoints, moving logic between browser and server, or reviewing architectural consistency.
---

# Take-Off Architecture

## Objective
Preserve Take-Off's existing boundaries. Extend existing patterns before introducing new architecture.

## System model

```text
Browser / public/
      |
      | authenticated requests
      v
Netlify Functions
      |
      +--> Supabase
      |
      +--> Anthropic / server-side image processing
```

The browser orchestrates user workflows. Trusted, privileged, AI, and authoritative processing belongs server-side.

## Repository responsibilities

### `public/`
Owns presentation, browser interaction, session-aware UI, and workflow initiation.

Do not place privileged credentials or authoritative authorization here.

### `public/lib/`
Contains reusable application/domain modules such as BOM, geometry, discovery, reconciliation, location, and pipeline logic.

Before creating new logic:
1. Search `public/lib/` for an existing implementation.
2. Extend an existing domain concept when appropriate.
3. Avoid duplicating calculations in page-specific scripts.

Prefer pure input -> output modules for domain calculations. Keep DOM access out of domain modules unless the module is explicitly a browser/UI abstraction.

### `netlify/functions/`
This is the trusted server boundary.

Use it for:
- Anthropic calls.
- Sharp/server-side image processing.
- authoritative database writes.
- operations requiring secrets.
- protected organization/project operations.
- trusted validation and processing.

Preserve the existing `pass-*` processing architecture unless a change explicitly replaces part of the pipeline.

### `netlify/functions/utils/`
Use for shared server infrastructure such as authentication, Supabase/Anthropic clients, and reusable processing helpers.

Do not duplicate auth/client initialization across handlers when a shared utility already exists.

### Supabase
Owns authentication, persistent application state, organization/project data, pages, device instances, and analysis state.

RLS is a database security boundary and must complement server authorization.

## Architectural invariants

1. Never move Anthropic credentials or privileged processing into `public/`.
2. Never expose the Supabase service-role key to browser code.
3. Browser/UI checks are not authorization.
4. Protected server operations must establish organization/resource access server-side.
5. Preserve page-level persisted processing state.
6. Prefer extending existing `public/lib/` domain modules over creating duplicate implementations.
7. Do not introduce a framework or major abstraction merely to make a local change.
8. Keep browser orchestration separate from authoritative server processing.
9. Changes to processing should account for retries, concurrency, and persisted state.
10. Search the repository before inventing a new pattern.

## Before implementing a change

Identify:
- Which layer owns the responsibility?
- Is there already a module/function for it?
- Is the result authoritative or only presentation state?
- Does it cross an organization/project security boundary?
- Does it invoke AI or require a secret?
- Does it alter persisted analysis/page state?

Then make the smallest change consistent with the architecture.

## Review checklist

When reviewing architecture changes, flag:
- duplicated domain logic,
- secrets or privileged operations in `public/`,
- authorization implemented only in UI,
- direct coupling between unrelated processing stages,
- page-specific code that duplicates shared infrastructure,
- new synchronous dependencies in long-running analysis,
- new global mutable state,
- changes that bypass existing `pass-*`, auth, or client utilities without a clear reason.

Do not recommend a wholesale rewrite when an incremental extension of the existing architecture is sufficient.
