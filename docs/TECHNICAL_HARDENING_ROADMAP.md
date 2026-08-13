# Take-Off --- PROD V1 / Technical Hardening Roadmap

## Goal

PROD V1 should be ready for a real customer to use without engineering
support for normal day-to-day use.

A customer should be able to:

**Create a project → upload plans → run analysis → review/correct
results → generate a BOM → export the result**

Before launch, we also need confidence that customer data is isolated,
processing is reliable, and production issues can be diagnosed.

------------------------------------------------------------------------

## Roadmap

``` mermaid
flowchart LR
    A["1. Production Foundation"] --> B["2. Reliable Processing"]
    A --> C["3. Customer Workflow"]
    B --> D["4. Production Operations"]
    C --> D
    D --> E["5. Production Validation"]
    E --> F["6. Pilot & PROD V1"]
```

**Phases 2 and 3 can run in parallel.**\
Phase 4 can begin alongside them, but depends on the final production
flows.\
Phases 5 and 6 depend on the earlier work being complete.

------------------------------------------------------------------------

# 1. Production Foundation

**Goal:** Make sure the application is safe to use with real customer
data and can be deployed consistently.

### Product outcome

Customers can only access their own organization's data, and production
is separated from development.

### Work

-   Verify Supabase Row Level Security (RLS) for all customer-owned
    data.
-   Test that Organization A cannot read or modify Organization B's
    data.
-   Verify user roles and permissions: owner, admin, member, viewer.
-   Review server authorization in `requireOrg()` and
    `assertProjectInOrg()`.
-   Confirm Supabase service-role and Anthropic API keys exist only on
    the server.
-   Add basic browser security protections, including CSP/XSS review.
-   Define reasonable PDF upload limits.
-   Separate development, staging, and production environments.
-   Require automated tests before production deployment.
-   Document database migration and rollback steps.

### Technical focus

`Supabase RLS` · `netlify/functions/utils/auth.js` · `clients.js` ·
environment variables · CI/CD · Netlify headers

### Done when

A user cannot cross organization boundaries, privileged credentials are
not exposed, and the team can deploy to staging and production
predictably.

------------------------------------------------------------------------

# 2. Reliable Processing

**Goal:** An analysis should finish reliably without depending on the
user's browser staying open.

### Product outcome

A customer can start an analysis, leave the page, return later, and see
its progress or result.

### Work

-   Add an analysis-level record that tracks the entire run.
-   Keep the existing page-level processing status underneath it.
-   Track whether an analysis is queued, processing, completed,
    partially completed, or failed.
-   Make retries safe so the same page cannot create duplicate or
    corrupted results.
-   Limit how many pages/AI requests can process at once.
-   Add controlled retry/backoff for Anthropic rate limits and temporary
    failures.
-   Allow failed pages to be retried without rerunning successful pages.

### Technical focus

Add/use:

``` text
analysis_id
status
page status
processing_version / run_id
attempt count
error
started_at / completed_at
```

The existing Netlify `pass-*` functions and persisted page state should
be extended rather than replaced.

### Target flow

``` mermaid
sequenceDiagram
    actor User
    participant App
    participant Job as Analysis
    participant Processing
    participant DB as Supabase

    User->>App: Start analysis
    App->>Job: Create analysis
    Job->>Processing: Process pages
    Processing->>DB: Save page progress/results
    App->>DB: Read analysis status
    DB-->>App: Progress / result
    Note over User,Processing: Processing continues if the user leaves
```

### Done when

Closing or refreshing the browser does not lose the analysis, failed
work can be safely retried, and processing volume is controlled.

------------------------------------------------------------------------

# 3. Complete the Customer Workflow

**Goal:** Make the existing analysis engine usable as a complete
customer product.

**Can run in parallel with Phase 2.**

### Product outcome

A customer can complete a take-off from beginning to end without
manually working around the application.

### Work

#### Review and correction

Users need to be able to:

-   review detected devices
-   add, remove, or correct detections
-   see pages that need attention
-   rerun a failed or incorrect page
-   distinguish analyzed results from reviewed/final results

AI output should be treated as something the user can review, not as an
automatically final result.

#### Final deliverables

Provide:

-   BOM export to CSV/XLSX
-   clean project/BOM summary
-   customer and project information on exports
-   saved final/reviewed results

An annotated plan/PDF export is valuable if it fits within V1.

#### History and administration

Users should be able to:

-   see previous analyses and their status
-   reopen completed work
-   see who ran/reviewed an analysis
-   invite/remove users
-   manage roles

#### Onboarding

A new customer should be able to create their first successful BOM
without developer assistance.

Include clear empty states, processing/error messages, and a simple
sample project or getting-started guide.

### Technical focus

Analysis history · reviewed/final state · export generation ·
RBAC-backed admin actions · persisted user corrections

### Done when

A new user can independently go from project creation to a reviewed,
downloadable BOM.

------------------------------------------------------------------------

# 4. Production Operations

**Goal:** Make production understandable and supportable when something
goes wrong.

### Product outcome

The team can answer: **What failed? Who was affected? Can we recover it?
What did it cost?**

### Work

-   Give every analysis a stable ID that appears in logs and support
    information.
-   Add structured error logging.
-   Track analysis success/failure and processing duration.
-   Track Anthropic usage and estimated cost per analysis.
-   Add alerts for unusual failure rates or cost spikes.
-   Define database backup and restore procedures.
-   Define customer/account data deletion procedures.
-   Create a short support runbook for failed analyses.

### Technical focus

Logs should carry:

``` text
organization_id
project_id
analysis_id
page_id
run_id / attempt
```

Do not log credentials, JWTs, or API keys.

### Done when

A production issue can be traced to a specific customer analysis and
safely diagnosed or recovered.

------------------------------------------------------------------------

# 5. Production Validation

**Goal:** Test the product the way customers will actually use it before
broad release.

### Validate

**Security** - Cross-tenant access tests pass. - Role/permission tests
pass. - No server secrets are exposed. - Critical security findings are
resolved.

**Reliability** - AI rate limits and timeouts are handled. - A failed
page does not lose successful pages. - Duplicate/retried requests do not
duplicate or corrupt results. - Browser refresh/close does not stop the
analysis. - Invalid or oversized PDFs fail cleanly.

**Performance** - Test representative small and large customer plans. -
Measure analysis duration, failure rate, AI usage, and cost.

**End-to-end workflow**

``` text
Sign in
  → Create project
  → Upload plans
  → Run analysis
  → Review/correct
  → Generate BOM
  → Export
```

### Done when

The complete workflow works reliably with realistic plans and there are
no launch-blocking security or reliability issues.

------------------------------------------------------------------------

# 6. Pilot & PROD V1

**Goal:** Validate the production product with real customers before
broad rollout.

Start with a small number of pilot customers and watch:

-   analysis accuracy
-   amount of manual correction required
-   processing failures
-   customer confusion/friction
-   cost per analysis
-   support requests
-   usefulness of the final BOM/export

Fix launch-blocking issues before expanding access.

## PROD V1 is ready when

  -----------------------------------------------------------------------
  Area                                Requirement
  ----------------------------------- -----------------------------------
  Security                            Customer data isolation and roles
                                      are tested

  Processing                          Analyses survive disconnects and
                                      retry safely

  Product                             Users can review results and
                                      produce a usable BOM

  Operations                          Failures can be identified and
                                      recovered

  Cost                                Usage and cost per analysis are
                                      measurable

  Quality                             Core workflow and failure scenarios
                                      are tested

  Customer readiness                  Pilot users can complete the
                                      workflow without engineering help
  -----------------------------------------------------------------------

------------------------------------------------------------------------

# Parallel Work

``` mermaid
flowchart TD
    A["1. Foundation"] --> B["2. Processing"]
    A --> C["3. Customer Workflow"]

    B --> D["4. Operations"]
    C --> D

    B -. "in parallel" .-> C

    D --> E["5. Validation"]
    E --> F["6. Pilot / PROD V1"]
```

### Can happen together

-   Reliable processing and customer-facing workflow work
-   Security testing and feature development
-   Logging/cost tracking and processing development
-   Onboarding/documentation and product stabilization

### Must happen in order

-   Security foundation before production customer data
-   Reliable analysis tracking before browser-independent processing
-   Completed customer + processing flows before final end-to-end
    validation
-   Production validation before broad PROD V1 launch

------------------------------------------------------------------------

# Not Required for PROD V1

Unless a pilot/customer contract specifically requires them, keep these
out of the critical path:

-   SAML / enterprise SSO
-   SCIM
-   public REST API
-   customer webhooks
-   ERP/procurement integrations
-   advanced billing automation
-   multi-region deployment
-   customer-hosted/VPC deployment
-   advanced collaboration/comments
-   dedicated mobile application
-   full SOC 2 certification

These may matter later, but they should not delay a secure, reliable
core product.
