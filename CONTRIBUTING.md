# Contributing

> Pre-alpha. The reproduce task runs end to end; fix and verify are next.
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
- `packages/core` — state transitions, task cards, write boundaries, ports. **Imports only `contracts`**:
  no `execa`, no `node:sqlite`, no `gh`, no `node:fs`. I/O lives behind ports that adapters implement.
- `packages/adapters` — all I/O. No adapter calls the GitHub API: the harness reports its own
  findings with `gh`. Enforced by `tests/import-boundaries.test.ts`.
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

## Releasing

Versions are never edited by hand. `changeset version` owns `apps/cli/package.json`,
and tsup injects that value into the binary at build time, so the number the CLI
reports cannot drift from the manifest.

Every change that should appear in the changelog needs a changeset:

```bash
pnpm changeset          # pick a bump, write one line describing the effect
```

Commit that file with your work. On merge to `main` the Release workflow opens a
**"chore: version packages"** PR that applies the bumps and writes `CHANGELOG.md`.
Merging that PR is the decision to release — it publishes to npm with a provenance
attestation and creates the GitHub Release.

A change with no user-visible effect (refactor, test, CI) needs no changeset.

### Prereleases

The repo is currently in prerelease mode, pinned by `.changeset/pre.json`. Versions
come out as `0.1.0-alpha.N` and publish under the `alpha` dist-tag, so `latest` is
left alone and `npm install -g issueforge` does not resolve to them.

To ship the first stable release:

```bash
pnpm changeset pre exit    # commit the result, then release as usual
```

Do not run `changeset pre enter` again afterwards without reading the changesets
prerelease docs — leaving and re-entering prerelease mode mid-stream produces
version numbers that surprise people.
