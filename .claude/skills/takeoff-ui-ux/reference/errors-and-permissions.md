# Take-Off Error, Destructive Action & Permissions UX

Detail reference for [../SKILL.md](../SKILL.md). Load this when working on error states, confirmations, permission-sensitive UI, or support/diagnostic views.

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
