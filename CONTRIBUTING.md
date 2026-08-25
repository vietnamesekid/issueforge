# Contributing

> Pre-alpha. The monorepo foundation is in place; feature work has not started yet.
> The design was validated up front against the real GitHub Actions runner, the real Claude Code
> CLI and real git behaviour, so the constraints below are measured rather than assumed.

## Setup

```bash
pnpm install
pnpm check      # typecheck + lint + test
```

The packages use TypeScript project references, so `tsc --build` resolves a sibling package from its
source and builds dependencies in the right order. That means a fresh clone typechecks without a
separate build step, and an editor never reports *"Could not find a declaration file for module
'@issueforge/core'"* just because `dist/` happens to be missing.

## Dev loop

Node runs TypeScript directly, so there is no build step while developing:

```bash
node apps/cli/src/main.ts --help
```

That works because every file is *erasable*: `erasableSyntaxOnly` is on, which bans enums,
namespaces with runtime code, parameter properties and decorators. Use `as const` objects or
union types instead of enums. This is a feature — it keeps the dev loop build-free and the code
portable across tsup, tsc and any bundler.

## Layout and the one rule that matters

```
contracts  ->  core  ->  adapters  ->  apps/cli
 (no deps)    (pure)     (io only)     (wiring)
```

- `packages/contracts` — schemas and types. Depends on nothing.
- `packages/core` — state transitions, evidence validation, policy. **Imports only `contracts`**:
  no `execa`, no `node:sqlite`, no `gh`, no `node:fs`. I/O lives behind ports that adapters implement.
- `packages/adapters` — all I/O. Harness adapters must not import the GitHub adapter, and vice versa.
- `apps/cli` — composition root. Nothing imports it.

`tests/import-boundaries.test.ts` enforces this and **fails CI** on a violation. It is the one piece
of architecture worth enforcing mechanically: it is what stops IssueForge drifting into a
coding-agent framework.

## Toolchain

pnpm (packages) · `pnpm -r` (tasks) · tsup (build) · `tsc --noEmit` (types) · Vitest (tests).
No Turborepo, no Vite — this is a headless CLI with no browser target. Vitest is the test runner
and is unrelated to Vite.

## Scope discipline

IssueForge orchestrates the outer workflow; the harness owns its own agent loop. If a change starts
to require planning steps, choosing tools, or calling a model, that is **scope drift** — say so in
the PR rather than building it.
