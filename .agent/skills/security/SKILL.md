---
name: takeoff-security
description: Use when adding or reviewing authentication, authorization, Supabase queries, Netlify Functions, organization/project access, admin actions, uploads, AI input/output, or secrets in Take-Off.
---

# Take-Off Security

## Core rule

Treat the browser as untrusted.

```text
Authenticated identity
        |
        v
Organization membership
        |
        v
Resource belongs to organization
        |
        v
Role/action permitted
        |
        v
Authoritative operation
```

UI visibility is never sufficient authorization.

## Existing security pattern

Take-Off uses server-side helpers including:
- `requireOrg()`
- `assertProjectInOrg()`

Inspect and reuse the existing helpers rather than creating ad hoc authorization.

Relevant code includes:
- `netlify/functions/utils/auth.js`
- `netlify/functions/utils/clients.js`
- protected `netlify/functions/*`
- Supabase RLS policies/migrations

## For every protected endpoint

Verify:
1. The caller is authenticated.
2. Organization identity/membership comes from trusted authenticated/server-side state.
3. Resource ownership is checked against the organization.
4. Required role/permission is checked for privileged actions.
5. Client-supplied `user_id`, `org_id`, `project_id`, or role is not blindly trusted.
6. Database access does not accidentally bypass the intended authorization model.

## Tenant isolation

Tenant isolation is a critical invariant.

Tests should prove:

```text
User A -> Org A resource       ALLOW
User A -> Org B resource       DENY
Admin A -> Org A admin action  ALLOW
Admin A -> Org B resource      DENY
Member -> admin action         DENY
Anonymous -> tenant data       DENY
```

RLS should be enabled and correctly defined for every tenant-sensitive table.

When adding a table, explicitly decide:
- Is it tenant scoped?
- What organization owns it?
- What are SELECT/INSERT/UPDATE/DELETE policies?
- Can ownership be derived through another resource?

## Secrets

Allowed in browser:
- Supabase anon/public key, assuming RLS is correct.

Server-only:
- Supabase service-role/admin key.
- Anthropic API key.
- any other privileged service credential.

Secrets should come from server environment variables and must not appear in:
- `public/`,
- browser bundles,
- API responses,
- logs,
- committed `.env` files.

## AI security

Treat Anthropic output as untrusted data.

Before persistence/use:

```text
AI response
  -> parse
  -> schema validation
  -> normalization
  -> business validation
  -> persist/render
```

Do not use AI output directly as:
- HTML,
- SQL,
- filesystem paths,
- shell commands,
- authorization decisions.

## PDF and image input

Uploaded documents are untrusted.

Enforce reasonable limits on:
- request/file size,
- page count,
- rendered dimensions,
- supported file types,
- processing duration,
- concurrency.

Fail clearly and safely when limits are exceeded.

## Browser/XSS review

Pay special attention to:
- `innerHTML`,
- AI-generated strings,
- user/project names,
- dynamically generated markup,
- third-party scripts.

Prefer safe DOM/text APIs for untrusted values. Preserve or strengthen CSP where configured.

## Security review output

Distinguish:
- **Confirmed vulnerability** — code demonstrates an exploitable weakness.
- **Security gap** — a required control is absent.
- **Verification item** — architecture depends on a control whose implementation has not been inspected.
- **Hardening** — defense-in-depth improvement.

Do not label something a vulnerability merely because it could theoretically be implemented incorrectly.
