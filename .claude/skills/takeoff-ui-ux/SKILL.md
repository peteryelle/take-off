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

---

## Additional resources

- For screen layouts and workflow details (projects, analysis list/detail, page review, re-run, export), see [reference/screens-and-workflows.md](reference/screens-and-workflows.md)
- For error handling, destructive actions, permissions, and support/diagnostics UX, see [reference/errors-and-permissions.md](reference/errors-and-permissions.md)
- For copy style, accessibility, performance, responsive behavior, UX testing priorities, and product metrics, see [reference/style-accessibility-metrics.md](reference/style-accessibility-metrics.md)
