---
name: takeoff-testing
description: Use when adding, fixing, running, or reviewing Take-Off tests, Jest/ESM configuration, domain tests, Netlify Function tests, security tests, processing failure tests, or CI test requirements.
---

# Take-Off Testing

## Goal

Tests should protect Take-Off's important product and security guarantees, not merely increase coverage.

## Repository context

The repository contains many `.mjs` domain-oriented tests and uses ES module syntax.

Tests may be organized under `tests/` with names such as:

```text
*.test.mjs
*.spec.mjs
```

When using Jest with ESM, preserve the repository's configured ESM execution strategy. Inspect `package.json` and Jest configuration before changing test syntax or module type.

Do not convert application/test modules to CommonJS merely to silence an ESM configuration issue.

## Testing layers

### 1. Pure domain tests

Prioritize deterministic modules under `public/lib/`, including areas such as:
- BOM,
- geometry,
- discovery,
- classification,
- reconciliation,
- symbol/device logic.

Test inputs/outputs and edge cases without DOM/network dependencies when possible.

### 2. Processing tests

For `pass-*` processing, cover more than successful output.

Required scenarios include:
- successful page run,
- malformed AI response,
- Anthropic timeout,
- Anthropic `429`,
- transient provider failure,
- database write failure,
- repeated request,
- concurrent runs for the same page,
- partial multi-page failure,
- stale run completing after a newer run.

### 3. Security integration tests

Tenant isolation is a launch-critical invariant.

Test:

```text
User A -> Org A        allowed
User A -> Org B        denied
Admin A -> Org A       allowed
Admin A -> Org B       denied
Member -> admin action denied
Anonymous -> data      denied
```

Test RLS directly where practical; do not rely solely on UI tests.

### 4. End-to-end PROD V1 flow

Protect the critical customer journey:

```text
Sign in
 -> Create project
 -> Upload plans
 -> Run analysis
 -> Review/correct
 -> Generate BOM
 -> Export
```

Not every edge case needs E2E coverage. Use E2E for the critical journey and integration/unit tests for detailed behavior.

## Idempotency tests

When processing persistence changes, explicitly verify:

```text
run request once
run equivalent request again
=> no duplicate logical results
=> no corruption
=> no loss of valid completed work
```

Also test concurrent/stale processing versions if supported.

## Test-writing rules

1. Test observable behavior, not implementation trivia.
2. Prefer small fixtures.
3. Make expected domain behavior obvious from the test.
4. Include edge/failure cases for production-critical paths.
5. Mock external AI calls in normal automated tests.
6. Do not make the default suite depend on live Anthropic calls.
7. Keep security tests explicit about actor, organization, action, and expected result.
8. When fixing a bug, add a regression test when feasible.
9. Avoid broad snapshots for complex AI/domain outputs when targeted assertions are clearer.
10. Keep tests deterministic.

## Before changing test configuration

Inspect:
- `package.json`,
- existing Jest config,
- current test filenames,
- ESM usage,
- CI commands.

If Jest reports no tests, verify `testMatch`/`roots` and naming before moving files.

If Jest reports `Cannot use import statement outside a module`, fix ESM/Jest execution configuration rather than rewriting correct `.mjs` imports.

## CI expectations

The production branch should not accept changes when required automated tests fail.

At minimum, CI should run:
- domain/unit tests,
- security/integration tests that are practical in CI,
- lint/static checks if configured.

Keep the local `npm test` workflow aligned with CI and repository documentation.
