# Take-Off Copy Style, Accessibility & Metrics

Detail reference for [../SKILL.md](../SKILL.md). Load this when writing UI copy, reviewing accessibility, or evaluating performance/responsive behavior and UX metrics.

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
