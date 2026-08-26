# IssueForge

A local-first GitHub IssueOps **supervisor**. A maintainer labels an issue, a self-hosted
runner spawns an already-installed coding agent (Claude Code / Codex) in a SHA-pinned
worktree, and **the agent reports its own findings** back to the issue with `gh`.

**IssueForge is not a coding agent.** It never plans steps, chooses tools, or calls a model,
and it writes no GitHub content — no comments, no labels, no PRs; the harness does all of it.
If a change requires planning, tool choice, or a model call, that is scope drift: say so
instead of building it.

## Commands

```bash
pnpm check                  # typecheck + lint + test — the arbiter, run before declaring done
pnpm test                   # runs `pnpm build` first, deliberately (see below)
pnpm test:unit              # vitest only, no build — fast loop
npx vitest run path/to.test.ts   # a single file
node apps/cli/src/main.ts --help  # run the CLI with no build step
```

`pnpm test` builds first because `sqlite-run-store.test.ts` spawns a second real process that
imports `packages/adapters/dist/index.js`; without a build it **warns and skips**, silently
losing the only two-process test. Everything else resolves `@issueforge/*` to `src`.

## The one rule enforced mechanically

```
contracts  ->  core  ->  adapters  ->  apps/cli
 (no deps)    (pure)     (io only)     (wiring)
```

`core` imports **only** `contracts` — no `node:fs`, `node:sqlite`, `execa`, `gh`. No adapter
imports `@octokit` or any GitHub API client. Nothing imports the CLI.
`tests/import-boundaries.test.ts` fails CI on a violation. It is what stops IssueForge
drifting into a coding-agent framework.

That test once guarded three deleted directories, caught its own `ENOENT`, and passed by
checking nothing. **When you add a boundary test, make it fail first.**

## Where new code goes

- **New task** (fix, verify) → a `TaskDefinition` value (`kind`, `buildCard`, `resultSchema`)
  in `adapters/src/runner/task-runner.ts`, then register it in `TASKS` in `main.ts` and in
  `INTENT_LABELS` in `contracts/src/github.ts`. **Do not copy `TaskRunner`** — its ordering is
  crash-safety logic and a second copy will rot.
- **New harness** → `adapters/src/harness/<name>/`.
- **New CLI command** → `apps/cli/src/commands/<name>.ts` exporting a *doer* (`runX`, returns
  data) and a *renderer* (`renderX`, returns a string), then wire it into `buildProgram()` in
  `main.ts`. Commands never touch stdout themselves — that split is what makes them testable.
  Get dependencies from `createContext()`; never construct adapters directly. Set
  `process.exitCode`, never call `process.exit`.
- New I/O → `adapters`; new rules about what a run may do → `core/domain`; new vocabulary →
  `contracts`.

A new file is invisible until exported from its directory's `index.ts`;
`packages/core/src/index.ts` is hand-curated, so split `export` from `export type` there.

## TypeScript rules that bite

These follow from `tsconfig.base.json`; each has drawn blood here.

- `process.env['X']` **in brackets** — `noUncheckedIndexedAccess` is on, so `dot-notation` is
  deliberately off in ESLint.
- `import type` for every type — `verbatimModuleSyntax` makes a value import of a type-only
  symbol emit a runtime require that throws.
- **No enums, namespaces with runtime code, parameter properties, or decorators** —
  `erasableSyntaxOnly` keeps every file erasable so `node src/main.ts` needs no build. Use
  `z.enum` or `as const` objects.
- Optional properties: use `optional()` / `optionalDefined()` from `contracts`.
  `...(x && { k: x })` silently drops `exitCode: 0` — a test caught that.
- `Sha`, `RunId`, `RepoSlug` are **branded**: a value can only come from `.parse()`. Parse at
  the boundary and pass it inward; in tests use `runId()` / `sha()` / `repoSlug()` from
  `contracts/src/testing.ts`. `x as Sha` is a no-op the compiler treats as `as string`.
- Nested Zod objects use **`.prefault({})`, never `.default({})`** — in Zod 4 a default is
  returned unparsed, so `.default({})` drops every inner default.
- `as X` needs a comment saying why the compiler cannot know. Never use it to silence a
  mismatch you could parse away. Non-null `!` is not used anywhere in this repo — restructure
  so the compiler narrows.
- Prefer a total `Record<Union, T>` when partitioning a set, so a new member fails to compile.

The repo has **zero** `any`, `@ts-expect-error`, non-null `!`, and `console.log` in `src/`,
and exactly one `eslint-disable` (with a justifying comment). Keep it that way.

## Errors and async

Throw across a layer boundary; return values within one, converting back to values at the CLI
boundary. An error class earns its place by being caught and *distinguished* somewhere — if a
new one would only ever be logged, throw `Error`. Carry what the catcher needs as readonly
fields, not in the message.

**Never regex-match an error message to decide control flow.** Classification once grep-matched
`/cancel/i`, so any harness error mentioning the word became `cancelled` — a terminal status
that stops retry. Carry the reason as a value (`HarnessRunError.reason`).

A silent `catch {}` is allowed only where failure *is* the answer (probing whether a CLI
exists, a lock insert losing its race) and must say so in a comment.

No floating promises (`no-floating-promises` is on, and is the main reason lint is
type-aware). `async` only if the function awaits. Clean up in `finally` — the issue lock
especially: a crashed run must never leave an issue stuck.

## Tests

**Write the test first and watch it fail.** A test written after a fix used `spawnSync`
(sequential, so it could never race) and passed against a genuine race condition.

Test behaviour, not structure. Prefer a real dependency where it is cheap — `:memory:` SQLite,
a tmpdir git repo — and reserve fakes for the slow or non-deterministic (the harness); use
hand-written fakes, not `vi.mock`. Name the bug in the test when there was one:

```ts
it('classifies EVERY status — a run is finished, or it is not', () => {
  // The bug this test exists for: TERMINAL and ACTIVE were two hand-maintained
  // arrays, and `interrupted` was in neither, so runs killed by the reaper were
  // the only ones cleanup never removed.
```

**Green tests say nothing about the shipped artifact.** Three bug classes here were invisible
until the built, installed, or live path was exercised — exercise the artifact, not just the
source.

## Comments

Density is ~26%, deliberately. Write **why**, never **what**: the constraint, the trap, the
experiment that produced the number. Cite evidence when there is some ("observed in 6 of 8
attempts"). A stale comment is worse than none.

## Naming

kebab-case files named for the concept; tests `<file>.test.ts` beside the source; PascalCase
types; SCREAMING_SNAKE module constants; `<Noun>Error` with `.name` set; a Zod schema and its
inferred type share one exported identifier. Classes use `#private`, not `private`.

Banned as file or directory names: `utils`, `helpers`, `common`, `manager`, `service`,
`handler`, `processor`, `types`. The one `common.ts` in `contracts` is the deliberate
exception.

## Security invariants — do not weaken

- **Issue text is data, never instructions.** It reaches the harness through the task-card
  *file*, never argv, never a shell string.
- All commands are **argv arrays with `shell: false`**. Long untrusted text goes via
  `--body-file`.
- The child env is an **allowlist (~7 vars), never a denylist** — a naive spawn inherits 82.
- MCP isolation is mandatory: `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
  `--setting-sources ""` does **not** disable MCP; a run was observed loading five of the
  developer's authenticated servers.
- Draft PRs only, never automatic merge. The backstop is a human reading a draft PR, which is
  why draft PRs are not optional.
- `.github/**`, `.git/**`, `**/.env`, keys are always forbidden write targets, checked after
  the run.

## Settled decisions — do not relitigate without new evidence

- **Node, not Bun.** `Bun.spawn` does not make the child a process-group leader, so
  `kill(-pgid)` returns `ESRCH` and processes survive.
- **`--setting-sources ""` is deliberately NOT used**, even though it would sandbox harder: it
  also blocks `CLAUDE.md`, skills and project conventions. A live run failed exactly that way —
  the agent could not discover the project used vitest. Repository config executing is an
  accepted, unmitigated risk, not a bug to fix.
- **`--bare` is deliberately NOT used** — it forces `ANTHROPIC_API_KEY` and breaks the promise
  to reuse the developer's existing login.
- **No evidence validator.** One existed, passed 8/8 lab fixtures, then rejected correct work
  on three consecutive live issues. Deleted. Do not reintroduce grading of the agent's work.
- **Success is a terminal event, never an exit code alone** — a real auth failure returned
  `subtype: "success"` with `is_error: true`.
- **Orphans are detected structurally** (live process group + dead owner via `pgid`/`ownerPid`/
  `ownerStart`), never from the ledger `status` column: a SIGKILLed supervisor never updates
  its own row.
- A negative finding is **not** an error: `cannot-reproduce` / `needs-info` / `could-not-fix`
  exit **0**. Non-zero is reserved for IssueForge itself failing.
- Do **not** split `main.ts`, `task-runner.ts`, `sqlite-run-store.ts`, or `events.ts`. Each is
  long because it owns one thing thoroughly.

## Gotchas

- Source of truth is `src/`. `packages/*/dist/` is gitignored build output and still contains
  stale `github/` and `validation/` directories for code deleted long ago — **grep `src/`
  only**.
- `packages/adapters/tsup.config.ts` is dead config, invoked by no script. Only `apps/cli`
  runs tsup; adapters' `dist/` comes from `tsc --build`.
- Config lives at `.issueforge/config.json` — **JSON, not YAML**. A past bug had the loader
  reading `config.yaml` while `init` wrote `config.json`, so every config was ignored in silence.
  A config key that nothing reads is a bug, not a placeholder: **if you add a key, wire it and
  test that it arrives.** Malformed config is an error, never a silent fallback — a broken file
  and an absent file must not look the same.
- `tests/` and `examples/` sit outside every package tsconfig: they lint **without** type
  info, so a rename can break them with no compile error.
- Shared dep versions live in the `catalog:` in `pnpm-workspace.yaml`, not in each manifest.
  `apps/cli` declares workspace packages as **devDependencies** on purpose — tsup bundles them
  (`noExternal`) because `workspace:*` is unresolvable on a global install.
- Commits: conventional prefix (`feat:`, `fix:`, `refactor:`), subject as a sentence describing
  the effect, body explaining *why* with measured evidence.
- Keep this file self-contained: it is read in fresh clones and in the worktree a run gets, so
  a pointer to an uncommitted file reads as a broken instruction. State the rule here instead.
