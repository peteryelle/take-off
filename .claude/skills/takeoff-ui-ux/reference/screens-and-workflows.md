# Take-Off Core Screens & Workflows

Detail reference for [../SKILL.md](../SKILL.md). Load this when working on specific screens, review flows, re-run behavior, or export.

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
