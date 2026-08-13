---
name: takeoff-ui-ux
description: Use when designing or changing Take-Off screens, workflows, navigation, analysis progress, review/correction experiences, exports, admin UX, errors, onboarding, or accessibility.
---

# Take-Off UI / UX

## Goal

Design Take-Off as a trustworthy production tool for estimators, reviewers, and project administrators.

Optimize for:

- clarity,
- reliability,
- auditability,
- fast review,
- low support burden.

Do not optimize only for visual polish. The UI should make system state, AI uncertainty, user actions, and recovery paths obvious.

---

## Product mental model

Take-Off is an AI-assisted schematic takeoff application.

The main customer workflow is:

```text
Create Project
    ↓
Upload Plans
    ↓
Configure Analysis
    ↓
Run Analysis
    ↓
Review / Correct
    ↓
Generate BOM
    ↓
Export
```

The UI should reinforce this flow and make it easy to understand where the user is within it.

---

# Core UX principles

## 1. Long-running work is durable

The browser is temporary.

Do not design analysis as if the user must keep the page open.

Preferred behavior:

```text
Start analysis
    ↓
Receive analysis_id
    ↓
Processing continues
    ↓
User may leave / refresh
    ↓
Return to current status
```

For long-running operations always show:

- current status,
- progress,
- completed vs remaining work,
- failure state,
- retry behavior,
- what the user can do next.

---

## 2. Make AI output reviewable

AI output is not automatically final.

Users should be able to understand and correct analysis results.

For important results provide:

- detected device,
- page/location context,
- confidence/evidence when useful,
- manual correction,
- accepted/reviewed state.

Do not present AI-generated results as authoritative without a review path where product requirements expect human verification.

---

## 3. Show system state clearly

Avoid vague states such as:

```text
Loading...
Working...
Something went wrong.
```

Prefer explicit states:

```text
Queued
Processing
Completed
Partially completed
Failed
Retrying
```

At page level:

```text
Pending
Running
Done
Failed
```

State shown in the UI should reflect durable server state, not only browser state.

---

## 4. Prefer recovery over dead ends

Every recoverable error should answer:

1. What happened?
2. What work was preserved?
3. What will happen next?
4. What can the user do?

Example:

```text
Page 37 could not be processed because the analysis provider timed out.

Completed pages were saved.
A retry is scheduled automatically.

[Retry now]
```

Avoid exposing raw technical errors unless they are inside a support/debug view.

---

## 5. Progressive disclosure

Most users need the result first, details second.

Preferred information hierarchy:

```text
Project / Analysis Summary
        ↓
Page-level status
        ↓
Device-level results
        ↓
Technical/debug details
```

Do not make estimators read AI payloads, model configuration, run IDs, or processing internals to complete normal work.

---

# Primary personas

## Estimator

Primary job:

> Produce a trustworthy BOM quickly enough to prepare an estimate or quote.

Prioritize:

- simple project setup,
- clear analysis progress,
- fast review,
- accurate BOM,
- clean export.

## Reviewer / Drafter

Primary job:

> Verify and correct detected devices and plan interpretation.

Prioritize:

- page inspection,
- annotated plans,
- add/remove/move corrections,
- evidence/context,
- selective rerun.

## Project Admin

Primary job:

> Manage people, projects, permissions, and usage.

Prioritize:

- users/roles,
- organization context,
- usage/cost visibility,
- audit history.

Do not allow admin screens to obscure normal estimator workflows.

---

# Core screens

## 1. Projects

A project list should make it easy to answer:

- What project is this?
- What is its current state?
- When was it last worked on?
- What action should I take next?

Prefer a clear primary action:

```text
Open project
```

Do not overload project rows/cards with low-value technical metadata.

---

## 2. Project / Plan Set

Show:

- project identity,
- uploaded plans,
- page count,
- upload/validation state,
- existing analyses,
- clear CTA to start or continue analysis.

Before starting expensive processing, surface useful expectations such as:

- selected pages,
- approximate scope,
- known limits,
- cost estimate if available.

---

## 3. Analysis List

Each analysis row/card should prioritize:

```text
Name / identifier
Status
Progress
Started / completed time
Result summary
Primary next action
```

Useful secondary information:

- pages completed,
- devices found,
- cost,
- model/config version.

Do not make `analysis_id` the primary user-facing name, but make it easy to copy for support.

---

## 4. Analysis Detail

Recommended structure:

```text
Header
├── Analysis name
├── Status
├── Progress
└── Actions

Summary
├── Pages complete
├── Pages failed
├── Devices found
└── BOM status

Page Grid
├── Page thumbnail
├── Status
├── Device count
└── Needs review indicator

Inspector
└── Selected page/device detail
```

Primary actions should depend on state.

Examples:

```text
Processing → View progress
Failed     → Review failures / Retry
Completed  → Review results
Reviewed   → Export BOM
```

---

## 5. Page Review / Inspector

The page review experience should combine visual context and structured data.

Useful layout:

```text
┌───────────────────────┬─────────────────────────┐
│                       │ Device / Review Panel   │
│ Annotated Plan        │                         │
│                       │ Detected devices        │
│ Pan / Zoom            │ Selected device         │
│ Overlays              │ Confidence/evidence     │
│                       │ Edit controls           │
└───────────────────────┴─────────────────────────┘
```

Support:

- pan/zoom,
- select device,
- add device,
- remove device,
- adjust/correct device,
- confirm/reject where applicable,
- retry page.

Useful optional overlays:

- labels,
- leaders/traces,
- confidence,
- detection regions.

Do not show every overlay by default.

---

# Review workflow

A review action should have an obvious effect on downstream results.

Example:

```text
Remove false-positive device
        ↓
Persist correction
        ↓
Update page result
        ↓
Update BOM
```

Users should not need to manually trigger several unrelated refresh actions after a correction.

Where practical, show:

```text
Unreviewed
Reviewed
Needs attention
```

rather than implying every AI detection has been manually approved.

---

# Re-run UX

Reprocessing should preserve history.

Avoid:

```text
Re-run → silently replace old analysis
```

Prefer:

```text
Analysis v1
    ↓
Re-run with changed configuration
    ↓
Analysis v2
    ↓
Compare
    ↓
Accept / retain previous result
```

When rerunning only one page, clearly state what will and will not change.

---

# Export UX

Exports must reflect the reviewed/final state.

At minimum support:

- CSV or XLSX BOM,
- clean project/analysis summary.

Where implemented, PDF/annotated-plan exports should include useful provenance such as:

- project,
- analysis,
- generated/reviewed date,
- relevant version information.

Do not export stale results after a user correction without making that state clear.

---

# Error UX

## Page-level failure

Prefer local failure over global failure.

```text
Analysis: 46 / 50 pages complete

4 pages need attention
[Review failed pages]
```

Do not present the entire analysis as unusable when most pages completed successfully.

## Provider rate limit

User-facing copy should explain impact, not provider internals.

Prefer:

```text
Processing is temporarily delayed.
We'll retry this page automatically.
```

Technical details such as `429` can appear in a support/debug area.

## Oversized PDF

Tell the user:

- the actual limit,
- why processing cannot continue,
- what they can do.

Example:

```text
This file contains 240 pages. The current limit is 200 pages.

Split the plan set into smaller files and upload them separately.
```

---

# Destructive actions

Use confirmation for actions that are difficult to recover from:

- delete project,
- remove user,
- delete analysis,
- change high-impact permissions,
- discard reviewed work.

Prefer an ordinary confirmation modal first.

Use typed confirmation only for genuinely high-impact/destructive operations. Do not require typed confirmation for routine actions.

---

# Permissions UX

The server decides permission.

The UI reflects that permission.

If the user cannot perform an action:

- hide it when it is irrelevant,
- disable/lock it when understanding the capability is useful,
- explain why when needed.

Do not implement security by hiding a button.

For role-sensitive screens, maintain clear organization context so users understand which organization/project they are administering.

---

# Support & diagnostics

Normal users should see simple error messages.

Technical diagnostics should be available without cluttering primary workflows.

A support/debug view may expose non-sensitive information such as:

```text
analysis_id
page_id
run_id
attempt
status
last processing stage
```

Provide a simple:

```text
Copy diagnostic information
```

action where useful.

Never expose:

- JWTs,
- API keys,
- service-role credentials,
- raw secrets.

---

# Copy style

Use concise, direct, action-oriented language.

Prefer:

```text
Start analysis
Retry page
Review results
Export BOM
Invite user
```

Avoid unnecessary internal terminology.

Bad:

```text
Create durable background analysis job
```

Better:

```text
Start analysis
```

The system may create a durable job internally; the customer does not need to understand the implementation.

Likewise:

Bad:

```text
Anthropic 429 response
```

Better:

```text
Processing is temporarily delayed. We'll retry automatically.
```

Expose technical language only where it helps administrators/support.

---

# Accessibility

Accessibility is part of completion criteria.

For UI work:

- use semantic HTML,
- label form controls,
- preserve visible focus,
- support keyboard navigation,
- do not communicate state using color alone,
- ensure status badges have text,
- use accessible modal/dialog behavior,
- provide text alternatives for important visual information.

## Annotated canvas

Canvas-heavy review must not make all core information inaccessible.

Pair the visual canvas with an accessible device/result list.

Users should be able to:

- navigate detected devices via keyboard,
- select a device from a list,
- understand page/device status without relying only on the drawing.

---

# Performance UX

Large plans are expected.

Avoid UI patterns that require rendering every large page simultaneously.

Prefer:

- thumbnail/lazy loading,
- virtualized or incremental lists where needed,
- progressive rendering,
- page-level loading,
- visible feedback during expensive actions.

Do not block the entire interface while one page is processing.

---

# Responsive behavior

Desktop is the primary workspace for detailed plan review.

Prioritize excellent desktop/tablet behavior for:

- annotated canvas,
- BOM tables,
- analysis review.

Mobile should support basic actions and status viewing, but a dedicated mobile editing experience is not required unless product requirements change.

---

# UX testing priorities

When changing a core workflow, validate the real user job.

High-value tasks:

### Estimator
- Create project.
- Upload plan.
- Start analysis.
- Find a failed page.
- Review results.
- Export BOM.

### Reviewer
- Find a false positive.
- Remove/correct it.
- Confirm BOM updates.

### Admin
- Invite user.
- Change role.
- Understand organization usage.

Measure friction by observing task completion, not only asking whether users like the interface.

---

# Product metrics

Useful UX/product metrics include:

- time to first successful analysis,
- time to reviewed BOM,
- percentage of analyses completed without manual retry,
- percentage of failed pages successfully recovered,
- corrections per analysis,
- export completion rate,
- onboarding completion,
- support requests per analysis.

Treat targets as product decisions. Do not hard-code arbitrary success thresholds into UI logic.

---

# Before implementing a UI change

Ask:

1. Which persona is performing this action?
2. What job are they trying to complete?
3. What server state is authoritative?
4. What happens if they refresh or leave?
5. What happens if only part of the operation fails?
6. Does the user need technical detail, or only actionable context?
7. Is the primary next action obvious?
8. Is the workflow keyboard/accessibility friendly?
9. Does this change preserve organization/role context?
10. Does the result update downstream views such as the BOM?

---

# UI review checklist

Flag UI changes that:

- depend on browser-only state for durable processing,
- hide processing failures,
- lose completed work after a partial failure,
- expose raw technical/provider errors to normal users,
- present AI output as unquestionably final,
- require users to understand internal architecture,
- make destructive actions too easy,
- duplicate existing UI patterns unnecessarily,
- rely only on color for state,
- make canvas interaction the only way to access important information,
- obscure organization/project context,
- show stale BOM/results after corrections,
- block the entire interface for page-level processing.

Prefer incremental improvements that fit the current Take-Off UI rather than recommending a full frontend rewrite.
