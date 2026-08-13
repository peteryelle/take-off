# Take-Off Architecture Review

## Purpose and Scope

This document converts the supplied Take-Off architecture finding into a structured software architecture review. It is intended to support code review, architecture discussion, technical-debt prioritization, security review, and future refactoring decisions.

> **Important scope note:** The findings below are based on the supplied architecture description, not an independent inspection of every repository file, Supabase policy, Netlify Function, or deployed environment. Statements from the architecture description are treated as reported design characteristics. Items marked **Verify** should be confirmed directly in the repository or deployment configuration before being treated as established facts.

---

# 1. Executive Summary

Take-Off is described as a web-based schematic drawing take-off application using a serverless architecture composed primarily of:

- A browser-hosted frontend under `public/`
- Client-side JavaScript business and processing modules
- Netlify Functions as server-side/API boundaries
- Supabase for authentication and PostgreSQL persistence
- Supabase Row Level Security (RLS) for data authorization
- Anthropic Vision for schematic/image interpretation
- PDF.js for PDF processing
- Sharp for server-side image processing

The architecture is lightweight and appropriate for an early-stage application because it minimizes infrastructure management and makes extensive use of managed services. The repository also appears to have extracted important computational logic into reusable modules under `public/lib/`, which is preferable to embedding all logic directly in HTML pages.

The main architectural concern is that the browser appears to own a substantial amount of application orchestration and business logic. PDF splitting, processing coordination, BOM generation, page-level state, authentication interception, and potentially other domain operations occur client-side. This can work at modest scale, but it creates increasingly important concerns around maintainability, security boundaries, consistency, observability, performance, and reliability as the application grows.

The most important areas to review in the actual repository are:

1. **Client/server responsibility boundaries**
2. **Authorization enforcement and Supabase RLS correctness**
3. **Long-running PDF/vision processing in synchronous serverless requests**
4. **Browser-side orchestration of expensive multi-page processing**
5. **Modularization of page-specific UI, API, and domain logic**
6. **Protection of privileged Supabase/service-role operations**
7. **Concurrency and rate limiting around external AI requests**
8. **Failure recovery and idempotency for multi-step analysis**
9. **Testing configuration and consistency**
10. **Observability across browser → Netlify → external services → Supabase**

### Overall Assessment

| Area | Assessment | Summary |
|---|---|---|
| Architecture | **Moderate / needs hardening** | Appropriate serverless foundation, but browser responsibilities appear broad and service boundaries need clearer definition. |
| Performance | **Moderate risk** | Client PDF processing and parallel AI requests can become expensive and unreliable for large documents. |
| Modularization | **Mixed** | `public/lib/` suggests useful extraction, but page-owned state and orchestration can lead to duplicated logic and tight UI/domain coupling. |
| Security | **Potentially strong foundation, verification required** | Supabase Auth + RLS can provide a strong model, but correctness depends heavily on policies and server-side enforcement. |
| Reliability | **Moderate risk** | Multi-step synchronous processing has partial-failure and retry concerns. |
| Scalability | **Moderate risk** | Serverless scales well at the request layer, but AI/API quotas, browser resources, concurrency, and synchronous workflows may become bottlenecks. |
| Maintainability | **Moderate** | Vanilla page-level architecture is simple initially but can become difficult to evolve as workflows and shared state expand. |

---

# 2. Current High-Level Architecture

The supplied architecture describes the following major layers:

```text
┌──────────────────────────────────────────────────────────────────┐
│                        Browser / Client                          │
│                                                                  │
│  public/*.html                                                   │
│  public/auth.js                                                  │
│  public/plan-set.js                                              │
│  public/lib/*.js        Domain/business/calculation logic        │
│  public/tools/*.js      Specialized processing logic             │
│                                                                  │
│  PDF parsing, UI state, orchestration, BOM generation            │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Fetch + Bearer JWT
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Netlify Functions                          │
│                                                                  │
│  API endpoints                                                   │
│  pass-symbol                                                     │
│  pass-visual-augment                                             │
│  privileged/server-side operations                               │
└───────────────┬─────────────────────────────┬────────────────────┘
                │                             │
                ▼                             ▼
┌────────────────────────────┐    ┌───────────────────────────────┐
│          Supabase          │    │       External Services       │
│                            │    │                               │
│  Auth                      │    │  Anthropic Vision             │
│  PostgreSQL                │    │  Image-processing libraries   │
│  Row Level Security        │    │                               │
└────────────────────────────┘    └───────────────────────────────┘
```

## Architectural Style

The application is best characterized as a:

**Static browser application + serverless API + managed backend services architecture**

This is not inherently problematic. In fact, it can be an effective architecture when:

- request workloads are relatively independent,
- processing jobs remain within serverless execution constraints,
- domain rules are well modularized,
- privileged operations remain server-side,
- RLS policies are comprehensive,
- client-side workloads remain bounded, and
- workflows do not require complex durable state.

The current PDF/AI workflow is the area most likely to challenge those assumptions.

---

# 3. Component Responsibility Review

## 3.1 Browser / Client Layer

### Reported Responsibilities

The browser currently appears responsible for:

- authentication session bootstrap,
- attaching JWTs to API requests,
- page-specific state,
- project/plan-set presentation,
- PDF splitting,
- image/page preparation,
- coordinating page analysis requests,
- aggregating processing results,
- BOM generation,
- device-type administration UI,
- report/export presentation.

### Positive Characteristics

- Static hosting reduces operational complexity.
- Domain logic appears to have been extracted into `public/lib/`.
- PDF work performed locally can reduce server-side transfer/compute requirements.
- Supabase's client libraries simplify authentication lifecycle management.

### Architectural Concern

The browser may be acting simultaneously as:

1. presentation layer,
2. workflow/orchestration layer,
3. domain/business layer,
4. document-processing layer, and
5. API client.

That concentration of responsibilities increases coupling.

### Recommendation

Create explicit logical boundaries even if the project remains vanilla JavaScript:

```text
public/
├── pages/             # page bootstrap/controllers
├── components/        # reusable presentation/UI behavior
├── api/               # API client modules
├── domain/            # pure domain rules
├── services/          # client-side orchestration
├── state/             # shared state/session abstractions
└── utils/             # generic utilities only
```

Do not move code merely to create folders. Refactor when a module currently mixes UI, API, state, and domain responsibilities.

---

# 4. Core Workflow Review

## 4.1 Authentication

### Current Reported Flow

```text
User
  ↓
login.html
  ↓
Supabase signInWithPassword()
  ↓
JWT/session stored by Supabase client
  ↓
auth.js session bootstrap
  ↓
Bearer token attached to /api/* requests
```

### Strengths

- Supabase Auth avoids custom password storage.
- JWT-based authentication fits serverless APIs.
- Automatic session refresh can reduce custom session-management code.

### Security Review

#### SEC-001 — Authorization must not depend on the browser
**Severity: CRITICAL if violated; otherwise verification item**

`auth.js` can prevent unauthorized UI access, but it must never be the actual authorization boundary.

A user can bypass browser JavaScript and call APIs directly.

**Required controls:**

- Netlify Functions must validate authenticated identity for protected operations.
- Supabase queries must execute under the correct user context where RLS is expected.
- Administrative operations must explicitly verify role/organization membership server-side.
- UI visibility rules must not be treated as authorization.

**Verify:**
- every protected function validates the incoming JWT,
- no API trusts a client-provided `user_id`, `organization_id`, or role without server-side validation,
- privileged service-role clients are never exposed to browser code.

#### SEC-002 — Browser token storage increases XSS impact
**Severity: HIGH**

The architecture states that the Supabase session is cached in `localStorage`.

If an attacker achieves script execution through XSS, browser-accessible tokens may be stolen.

**Recommendations:**

- aggressively prevent XSS,
- avoid unsafe `innerHTML` with untrusted content,
- sanitize rendered AI/user-derived content,
- deploy a restrictive Content Security Policy,
- audit third-party scripts,
- avoid dynamic `eval`/Function execution,
- review whether the current Supabase session-storage strategy is appropriate for the threat model.

This does not mean local storage automatically makes the application insecure; it means XSS becomes especially consequential.

---

# 5. Project and Plan-Set Discovery

### Current Reported Flow

```text
Authenticated browser
    ↓
GET projects
    ↓
Supabase / API
    ↓
RLS-filtered project records
    ↓
Select project
    ↓
Load associated plan sets
```

### ARCH-001 — Data access boundaries need to be consistent
**Severity: HIGH**

The architecture description sometimes presents browser requests as `/api/*` calls while also describing Supabase as the direct database layer. The repository should establish a consistent rule for when the browser accesses Supabase directly versus when requests pass through Netlify Functions.

Without such a rule, the application can evolve into two competing data-access architectures.

### Recommended Boundary

Use direct Supabase client access only for operations intentionally protected entirely by RLS and safe for browser execution.

Use server-side functions when:

- service credentials are required,
- authorization requires additional business rules,
- external services are called,
- writes span multiple resources,
- transactional orchestration is required,
- request payloads require trusted validation,
- audit behavior is required,
- rate limiting is required.

Document this rule in the repository.

---

# 6. Multi-Page PDF Processing

This is the most architecturally significant workflow described.

## Current Reported Pipeline

```text
PDF upload
   ↓
Browser splits PDF into pages
   ↓
Pages/images prepared client-side
   ↓
Multiple pass-symbol requests
   ↓
Anthropic Vision
   ↓
pass-visual-augment / Sharp
   ↓
Results returned to browser
   ↓
Browser aggregates results
   ↓
Analysis persisted to Supabase
```

The description also states that processing can occur in parallel across up to eight strips and that heavy requests can have approximately 60-second timeouts.

## PERF-001 — Large PDF processing can exhaust browser resources
**Severity: HIGH**

Rendering and splitting a multi-page PDF can consume substantial:

- CPU,
- memory,
- browser main-thread time,
- image buffer space,
- network bandwidth.

Large architectural drawings can be especially expensive because high-resolution rasterization creates large intermediate images.

### Impact

Potential symptoms include:

- frozen UI,
- browser tab crashes,
- excessive memory use,
- slow processing,
- poor performance on lower-powered devices,
- repeated work after refresh or failure.

### Recommendations

1. Process pages incrementally instead of rasterizing the entire document at once.
2. Release page canvases/image buffers after processing.
3. Use Web Workers for CPU-intensive client processing where appropriate.
4. Bound concurrency based on workload/device capacity.
5. Track processing progress explicitly.
6. Avoid retaining full-resolution images longer than necessary.
7. Benchmark representative 10-, 50-, 100-, and 200-page documents.

---

## PERF-002 — Fixed parallelism can overload downstream services
**Severity: HIGH**

The reported use of parallel submissions "up to 8 strips" should be reviewed carefully.

Eight concurrent operations may multiply into:

- multiple Netlify executions,
- multiple Anthropic requests,
- multiple Sharp transformations,
- concurrent Supabase writes.

### Risks

- Anthropic rate limits,
- Netlify concurrency pressure,
- transient 429/5xx failures,
- cost spikes,
- inconsistent completion,
- browser/network saturation.

### Recommendation

Use a bounded work queue rather than unrestricted `Promise.all()` behavior.

Conceptually:

```text
Pending pages
    ↓
Concurrency controller
    ├── worker 1
    ├── worker 2
    ├── worker 3
    └── worker N
          ↓
Retry policy / backoff
          ↓
Result persistence
```

Concurrency should be configurable rather than hard-coded.

---

## ARCH-002 — Long-running AI work should evolve toward asynchronous jobs
**Severity: HIGH**

A synchronous request model is fragile for expensive PDF/image/AI processing.

### Current Pattern

```text
Browser → Function → Vision API → Processing → Browser
```

The browser must remain connected while the operation completes.

### Failure Scenarios

- user refreshes the page,
- laptop sleeps,
- request times out,
- AI provider returns 429,
- one page fails after 40 pages succeeded,
- serverless function reaches execution limit,
- deployment occurs mid-analysis.

### Recommended Target

```text
Browser
   │
   │ POST /analysis-jobs
   ▼
Job API
   │
   ├── persist job
   └── enqueue work
           │
           ▼
      Worker / processor
           │
           ├── PDF/page processing
           ├── AI requests
           ├── retries
           └── incremental persistence
                    │
                    ▼
                Supabase
                    │
                    ▼
Browser polls/subscribes to job status
```

A durable job model enables:

- retries,
- resumability,
- progress tracking,
- partial-result persistence,
- better observability,
- rate control,
- independence from the browser session.

The supplied architecture already lists a background job queue as a future enhancement. Based on the described processing model, this should be considered an architectural priority rather than merely a future convenience.

---

# 7. BOM Generation

## Current Reported Flow

The client:

1. retrieves device instances,
2. retrieves device type/assembly definitions,
3. calls `aggregateBom(instances, types)`,
4. expands device instances,
5. aggregates component quantities,
6. renders the result.

Functions reportedly include:

- `labelKind()`
- `deviceKinds()`
- `expandInstance()`
- `aggregateBom()`

## Positive Architectural Finding

`public/lib/bom.js` appears to encapsulate BOM domain behavior instead of placing it directly inside UI code. This is a good modularization pattern, especially if these functions are pure and independently tested.

## PERF-003 — Ensure assembly lookup is indexed in memory
**Severity: MEDIUM / Verify**

If `aggregateBom()` repeatedly scans the complete device-type array for each device instance, complexity can trend toward:

```text
O(instances × deviceTypes)
```

A lookup map can reduce repeated lookup work:

```text
device_type_id → assembly definition
```

leading closer to:

```text
O(instances + deviceTypes)
```

This should only be changed if the implementation actually performs repeated scans.

## ARCH-003 — Determine whether BOM is authoritative client or server data
**Severity: MEDIUM**

If BOM output affects pricing, procurement, contractual output, or persisted business records, consider whether it should be calculated or validated server-side.

Client-side calculation is appropriate for presentation and preview, but authoritative business results should not depend solely on client-executed logic when users can alter that code/runtime.

---

# 8. Device Type Configuration

Device types and assembly templates appear to influence future analysis and BOM generation.

## SEC-003 — Administrative writes require server-side authorization
**Severity: CRITICAL if absent**

The UI may hide administration screens, but write authorization must be enforced independently.

Verify:

- admin/owner roles are checked through RLS or server-side logic,
- organization ownership is validated,
- a user cannot submit another organization's identifier,
- mass assignment cannot modify protected columns,
- service-role credentials are not used in a way that bypasses authorization without replacement checks.

## REL-001 — Configuration changes may need versioning
**Severity: MEDIUM**

The architecture states that updated assembly definitions are used for new analyses.

That raises an important domain question:

**Can an old analysis be reproduced after a device type or assembly definition changes?**

If reproducibility matters, store:

- assembly version,
- device-type version,
- analysis timestamp,
- model/prompt version,
- processing pipeline version.

A BOM generated today should not silently change tomorrow because the underlying template was edited unless that is explicitly desired.

---

# 9. User and Organization Management

The supplied design uses Supabase administrative APIs server-side for invitations.

## SEC-004 — Supabase service-role credentials must remain server-only
**Severity: CRITICAL**

Any key capable of `supabase.auth.admin.*` operations must never be delivered to browser JavaScript.

Verify that:

- the service-role key exists only in server-side environment configuration,
- it is never bundled into `public/`,
- it is never returned through an API response,
- logs do not expose it.

## SEC-005 — Organization isolation must be tested as a security invariant
**Severity: CRITICAL**

Multi-tenant systems should assume tenant isolation is a primary security boundary.

Tests should explicitly attempt:

```text
User A → Project A       ALLOWED
User A → Project B       DENIED
Admin A → Org A data     ALLOWED
Admin A → Org B data     DENIED
User → admin operation   DENIED
Unauthenticated → data   DENIED
```

RLS policy tests are more important than simply confirming that the UI hides inaccessible data.

---

# 10. Modularization Review

## MOD-001 — Page-level state can produce duplicated architecture
**Severity: HIGH**

The architecture states:

> Each HTML file manages its own DOM state.

This is simple at first, but repeated patterns often emerge:

- authentication checks,
- loading state,
- error handling,
- API requests,
- notification rendering,
- URL parsing,
- organization context,
- project context,
- formatting,
- retries.

### Recommendation

Extract shared concerns into narrowly focused modules.

Example:

```text
public/
├── api/
│   ├── client.js
│   ├── projects-api.js
│   ├── analysis-api.js
│   └── device-types-api.js
├── auth/
│   └── session.js
├── domain/
│   ├── bom.js
│   ├── geometry.js
│   ├── discovery.js
│   └── classification.js
├── services/
│   └── analysis-service.js
└── pages/
    ├── projects-page.js
    ├── plan-set-page.js
    └── device-types-page.js
```

This can be done without introducing a frontend framework.

---

## MOD-002 — Keep pure domain modules independent of browser APIs
**Severity: HIGH**

Modules such as:

- `bom.js`
- `geometry.js`
- `symbol.js`
- `discover.js`

should ideally avoid direct dependency on:

- `document`,
- DOM elements,
- `window`,
- `localStorage`,
- fetch,
- page-specific state.

Pure modules are easier to:

- unit test,
- reuse,
- reason about,
- execute server-side,
- benchmark.

A useful architectural rule is:

```text
UI → services → domain
API → services → domain

domain → no UI dependency
domain → no page dependency
```

---

# 11. Security Architecture Review

## Security Boundary

The most important architectural security rule is:

```text
The browser is untrusted.
```

Anything sent by the browser can be modified.

This includes:

- user IDs,
- organization IDs,
- project IDs,
- device type IDs,
- roles,
- analysis results,
- BOM results,
- AI-derived results,
- filenames,
- MIME types,
- request counts.

Server-side code and RLS must independently establish what the caller is allowed to do.

---

## SEC-006 — AI output must be treated as untrusted data
**Severity: HIGH**

Anthropic Vision responses should not automatically be considered safe or correct.

Risks include:

- malformed structured output,
- unexpected strings,
- prompt-influenced document content,
- oversized output,
- incorrect classifications,
- content later rendered into HTML,
- invalid identifiers.

### Recommendation

Validate AI output against a strict schema before persistence or rendering.

Conceptually:

```text
AI response
    ↓
Parse
    ↓
Schema validation
    ↓
Normalization
    ↓
Business-rule validation
    ↓
Persistence
```

Never use AI output directly to construct SQL, filesystem paths, HTML, shell commands, or privileged actions.

---

## SEC-007 — File/PDF inputs require explicit limits
**Severity: HIGH**

Uploaded PDFs are attacker-controlled input.

Enforce limits for:

- total file size,
- page count,
- rendered dimensions,
- per-page image size,
- supported MIME/type,
- processing duration,
- number of concurrent pages.

The application should fail predictably instead of attempting unbounded processing.

---

## SEC-008 — CORS is not authorization
**Severity: MEDIUM**

The architecture notes restricted CORS origins.

CORS prevents certain browser-based cross-origin interactions. It does not prevent direct HTTP clients from calling an API.

Authentication and authorization must remain independent of CORS.

---

# 12. Reliability and Failure Handling

## REL-002 — Multi-stage processing needs explicit state
**Severity: HIGH**

The PDF workflow should not be represented only as "started" and "complete."

Use explicit states such as:

```text
QUEUED
  ↓
PREPARING
  ↓
PROCESSING
  ↓
AGGREGATING
  ↓
PERSISTING
  ↓
COMPLETED

Possible exits:
FAILED
PARTIALLY_COMPLETED
CANCELLED
```

For page-level work:

```text
PENDING → PROCESSING → COMPLETED
                     ↘ FAILED
```

This supports retry and diagnostics.

---

## REL-003 — Writes should be idempotent
**Severity: HIGH**

If a user retries after a timeout, the same page or analysis should not create duplicate records.

Use stable identifiers such as:

```text
analysis_id
page_id
processing_version
attempt_id
```

and design persistence so repeated completion requests do not duplicate the logical result.

---

## REL-004 — External requests require timeout/retry policy
**Severity: HIGH**

Anthropic and other network operations should have:

- explicit timeout,
- bounded retries,
- exponential backoff,
- jitter,
- handling for 429,
- handling for transient 5xx,
- no blind retry for permanent 4xx errors.

Retries should be coordinated so the browser, function, and provider layers do not all independently retry the same operation and amplify traffic.

---

# 13. Observability

## ARCH-004 — Distributed processing needs correlation IDs
**Severity: MEDIUM**

The workflow crosses:

```text
Browser
→ Netlify
→ Anthropic
→ Supabase
```

A failure can be difficult to trace without a common identifier.

Use:

```text
request_id
analysis_id
job_id
page_id
```

in structured logs.

Example:

```json
{
  "event": "vision_processing_failed",
  "analysis_id": "...",
  "page_id": "...",
  "attempt": 2,
  "provider": "anthropic",
  "duration_ms": 18432,
  "status": 429
}
```

Do not log JWTs, API keys, or sensitive document contents.

---

# 14. Testing Architecture

The supplied architecture describes tests for BOM logic, symbol detection, geometry, signals, leaders/traces, pipeline behavior, discovery, detection, and reconciliation.

This indicates useful attention to computational/domain logic.

## TEST-001 — Standardize the test runner and documentation
**Severity: MEDIUM**

The supplied architecture states that tests are `test/*.mjs` and use Node's built-in test runner. If the repository is being migrated to Jest, documentation, file naming, scripts, and module configuration must be updated consistently.

Avoid a repository where:

- documentation says `node --test`,
- `package.json` invokes Jest,
- tests use `.mjs`,
- Jest is not configured for ESM.

Choose one supported strategy and document it.

## TEST-002 — Add authorization/RLS tests
**Severity: HIGH**

Security-sensitive multi-tenant behavior needs integration tests.

## TEST-003 — Add failure-path tests for processing
**Severity: HIGH**

Test:

- one page fails,
- provider times out,
- provider returns 429,
- malformed AI response,
- persistence fails after AI succeeds,
- duplicate retry,
- user refreshes/restarts,
- oversized PDF,
- unauthorized analysis access.

## TEST-004 — Add representative performance fixtures
**Severity: MEDIUM**

Benchmark representative documents by:

- pages,
- PDF size,
- rasterized dimensions,
- symbol density,
- concurrent requests.

Track:

- peak browser memory,
- page processing latency,
- end-to-end latency,
- external request count,
- failure rate.

---

# 15. Recommended Target Architecture

The existing architecture does not need to be replaced wholesale.

A pragmatic evolution is:

```text
┌───────────────────────────────┐
│            Browser            │
│                               │
│ UI / rendering                │
│ authentication session        │
│ lightweight document preview  │
│ API client                    │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│      API / Netlify Layer      │
│                               │
│ authentication validation     │
│ authorization                 │
│ input validation              │
│ job creation                  │
│ CRUD                          │
└──────────────┬────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌───────────────┐  ┌──────────────────┐
│   Supabase    │  │ Processing Queue │
│               │  │ / durable jobs   │
│ PostgreSQL    │  └────────┬─────────┘
│ Auth / RLS    │           │
└───────────────┘           ▼
                    ┌──────────────────┐
                    │ Processing Worker │
                    │                  │
                    │ PDF/image work   │
                    │ AI orchestration │
                    │ retry/backoff    │
                    │ validation       │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ External AI/API  │
                    └──────────────────┘
```

### Responsibility Principle

**Browser owns interaction.**

**Domain modules own deterministic business rules.**

**API owns trust-boundary validation and authorization.**

**Workers own long-running processing.**

**Database owns durable state.**

---

# 16. Prioritized Findings

| ID | Severity | Category | Finding | Recommended Action |
|---|---|---|---|---|
| SEC-001 | Critical if absent | Security | Browser authentication gate cannot be authorization boundary | Verify server/RLS authorization on every protected operation |
| SEC-003 | Critical if absent | Security | Administrative writes require trusted authorization | Enforce role + tenant checks server-side/RLS |
| SEC-004 | Critical | Security | Supabase admin/service-role credentials must remain server-only | Audit environment and public bundle |
| SEC-005 | Critical | Security | Tenant isolation is a primary security invariant | Add explicit cross-tenant denial tests |
| PERF-001 | High | Performance | Client-side large PDF processing may exhaust browser resources | Stream/increment pages, free buffers, benchmark |
| PERF-002 | High | Performance | Fixed parallel AI processing can overload downstream services | Introduce bounded configurable concurrency |
| ARCH-002 | High | Architecture | Long-running AI workflow is fragile when synchronous | Introduce durable asynchronous job processing |
| MOD-001 | High | Modularization | Per-page state/orchestration can duplicate application infrastructure | Extract shared API/state/service modules |
| MOD-002 | High | Modularization | Domain modules should remain independent of browser APIs | Keep computational modules pure |
| SEC-006 | High | Security | AI output is untrusted input | Schema-validate and normalize responses |
| SEC-007 | High | Security | PDF inputs require bounded resource limits | Enforce file/page/dimension/time limits |
| REL-002 | High | Reliability | Processing needs explicit durable state | Introduce job/page state machine |
| REL-003 | High | Reliability | Retryable workflows need idempotent persistence | Use stable operation identifiers/upserts |
| REL-004 | High | Reliability | External AI requests require coordinated retry policy | Add timeout/backoff/jitter and 429 handling |
| TEST-002 | High | Testing | RLS/authorization needs direct integration tests | Test cross-user/cross-org denial |
| TEST-003 | High | Testing | Failure paths need coverage | Add partial failure/retry/malformed response tests |
| ARCH-001 | High | Architecture | Direct Supabase vs API access boundary is unclear | Document and enforce data-access rules |
| ARCH-003 | Medium | Architecture | Client BOM may or may not be authoritative | Decide trust model and server-validate if required |
| REL-001 | Medium | Reliability | Mutable assembly definitions may harm reproducibility | Version configuration used by analyses |
| SEC-008 | Medium | Security | CORS may be mistaken for API protection | Treat CORS only as browser policy |
| ARCH-004 | Medium | Observability | Cross-service workflows need correlation | Add structured IDs/logging |
| TEST-001 | Medium | Testing | Test runner/configuration must be consistent | Standardize Jest vs Node test strategy |
| TEST-004 | Medium | Performance | No performance baseline is described | Add representative benchmarks |
| PERF-003 | Medium / Verify | Performance | BOM lookup may perform repeated scans | Use lookup maps if implementation confirms issue |

---

# 17. Refactoring Roadmap

## Phase 1 — Security and Correctness Verification

Before major architectural refactoring:

1. Audit all Supabase RLS policies.
2. Audit every Netlify Function authentication path.
3. Confirm privileged Supabase keys never reach the browser.
4. Add cross-tenant authorization tests.
5. Validate all AI responses before persistence.
6. Add explicit PDF/input resource limits.
7. Verify administrative actions independently of UI controls.

### Expected Effort
**Medium**

### Priority
**Immediate / before production hardening**

---

## Phase 2 — Processing Reliability

1. Add `analysis_id` and page-level processing state.
2. Make processing writes idempotent.
3. Implement bounded concurrency.
4. Implement provider timeout/retry/backoff behavior.
5. Persist partial progress.
6. Add correlation IDs and structured logging.

### Expected Effort
**Medium**

### Priority
**High**

---

## Phase 3 — Asynchronous Processing

Move expensive document/AI analysis from a browser-held synchronous workflow toward durable background processing.

1. Create analysis job.
2. Persist job.
3. Queue page processing.
4. Process asynchronously.
5. Persist each page result.
6. Aggregate server-side or in a deterministic shared domain module.
7. Expose progress to browser.
8. Allow retry/resume.

### Expected Effort
**Large**

### Priority
**High as workload grows**

---

## Phase 4 — Client Modularization

Refactor shared browser responsibilities into:

- API client layer,
- authentication/session module,
- domain modules,
- orchestration services,
- page controllers,
- reusable UI components.

Do this incrementally rather than rewriting the frontend.

### Expected Effort
**Medium**

### Priority
**Medium**

---

## Phase 5 — Reproducibility and Versioning

Version:

- device definitions,
- assembly templates,
- AI model configuration,
- prompt versions,
- processing pipeline versions.

Persist those versions with each analysis.

### Expected Effort
**Medium**

### Priority
**Medium**

---

# 18. Repository Review Checklist

Use this checklist while validating the architecture against the actual code.

## Authentication and Authorization

- [ ] Every protected Netlify Function verifies authenticated identity.
- [ ] No endpoint trusts a client-provided user identity.
- [ ] No endpoint trusts a client-provided organization membership.
- [ ] Admin operations verify admin/owner permissions.
- [ ] RLS is enabled on every tenant-sensitive table.
- [ ] Cross-tenant access tests exist.
- [ ] Service-role keys are server-only.

## Client Security

- [ ] Untrusted strings are not inserted through unsafe HTML APIs.
- [ ] AI-derived text is treated as untrusted.
- [ ] Content Security Policy is configured.
- [ ] Third-party scripts are reviewed.
- [ ] Sensitive data is not written to browser logs/storage unnecessarily.

## API Security

- [ ] Request bodies are schema-validated.
- [ ] Resource ownership is checked.
- [ ] CORS is configured but not treated as authorization.
- [ ] Request-size limits exist.
- [ ] Rate/concurrency limits exist for expensive endpoints.
- [ ] Errors do not expose secrets/internal stack information.

## PDF / AI Processing

- [ ] Maximum PDF size is defined.
- [ ] Maximum page count is defined.
- [ ] Maximum raster dimensions are defined.
- [ ] Concurrency is bounded.
- [ ] External requests have timeouts.
- [ ] 429/5xx retries use bounded backoff.
- [ ] AI output is schema-validated.
- [ ] Partial progress is persisted.
- [ ] Retries are idempotent.
- [ ] Users can recover from partial failures.

## Architecture

- [ ] UI modules do not contain unnecessary domain logic.
- [ ] Domain modules do not depend on DOM/browser globals.
- [ ] API calls are centralized.
- [ ] Direct Supabase access has an explicit architectural rule.
- [ ] Long-running work has a migration path to background jobs.
- [ ] Shared page behavior is not duplicated.

## Performance

- [ ] Large PDFs are processed incrementally.
- [ ] Image buffers are released after use.
- [ ] Browser main-thread blocking is measured.
- [ ] AI concurrency is configurable.
- [ ] BOM/device lookups avoid unnecessary repeated scans.
- [ ] Representative performance benchmarks exist.

## Testing

- [ ] Test runner and ESM configuration are documented.
- [ ] Unit tests cover pure domain logic.
- [ ] Integration tests cover Supabase/RLS.
- [ ] Failure paths are tested.
- [ ] Retry/idempotency behavior is tested.
- [ ] Large-document performance is benchmarked.

## Observability

- [ ] Analysis/job IDs appear in relevant logs.
- [ ] Page-level processing failures are traceable.
- [ ] External API latency/status is recorded.
- [ ] Sensitive values are redacted.
- [ ] Processing duration and failure rates can be measured.

---

# 19. Final Architecture Assessment

The described Take-Off architecture has a sensible early-stage serverless foundation. Netlify and Supabase reduce infrastructure burden, and the extraction of computational behavior into modules such as `bom.js`, `geometry.js`, `symbol.js`, `discover.js`, and `pipeline.js` provides a useful basis for maintainability.

The key architectural issue is not that serverless technology is inappropriate. It is that **the application appears to be approaching the point where browser-driven synchronous orchestration is carrying too much responsibility**.

The architecture should evolve by strengthening boundaries rather than through a wholesale rewrite:

```text
Keep:
✓ Netlify/static deployment model
✓ Supabase Auth/PostgreSQL/RLS
✓ Pure JavaScript domain modules
✓ Serverless APIs for normal request/response operations

Strengthen:
→ server-side authorization
→ RLS verification
→ input/output validation
→ module boundaries
→ processing state
→ idempotency
→ observability
→ concurrency control

Evolve:
Browser-held long-running processing
        ↓
Durable asynchronous analysis jobs
```

The highest-priority code-review work should therefore focus on **trust boundaries, tenant isolation, long-running processing reliability, concurrency, and separation of UI/orchestration/domain responsibilities** before spending significant effort on cosmetic refactoring.

---

# Appendix A — Source Architecture Summary

This review was produced from the supplied architecture finding describing:

- static pages and JavaScript under `public/`,
- reusable business logic under `public/lib/`,
- Netlify Functions,
- Supabase Auth/PostgreSQL/RLS,
- Anthropic Vision,
- PDF.js,
- Sharp,
- project and plan-set discovery,
- PDF analysis,
- device configuration,
- BOM generation,
- user/organization administration,
- unit tests,
- Netlify deployment.

Items identified as concerns in this document should be validated against the implementation before being entered as confirmed defects.
