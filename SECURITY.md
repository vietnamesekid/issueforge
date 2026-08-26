# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/vietnamesekid/issueforge/security/advisories/new).
Please do not open a public issue for a vulnerability.

This is a pre-alpha project maintained in spare time. Expect a first response within
a week; there is no paid support and no bounty.

## What IssueForge is, in security terms

IssueForge runs a coding agent **on your own machine**, triggered by a label on a
GitHub issue. That means:

- **Issue text is attacker-controlled input.** On a public repository, anyone can
  open an issue. The agent reads that text.
- **A self-hosted runner executes on your hardware**, with your network access.
- **The agent runs with your credentials**, because IssueForge deliberately reuses
  your existing Claude Code login rather than demanding an API key.

**Use a private repository.** This is the single most important control, and it is
why the README, `issueforge init` and the generated workflow all say so.

## Boundaries that are enforced

These are invariants, covered by tests. A change that weakens one is a vulnerability,
not a refactor.

- **Issue text is data, never instructions.** It reaches the harness through a
  task-card *file*, never as argv and never inside a shell string.
- **Every command is an argv array with `shell: false`.** Long untrusted text is
  passed via `--body-file`.
- **The child environment is an allowlist** of roughly seven variables, never a
  denylist. A naive spawn would inherit 82.
- **MCP is disabled** with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
  A run was once observed loading five of the developer's authenticated MCP servers;
  `--setting-sources ""` alone does not prevent that.
- **Pull requests are always drafts, never auto-merged.** The backstop is a human
  reading a draft PR, which is why draft-only is not configurable.
- **`.github/**`, `.git/**`, `**/.env` and key material are forbidden write targets**,
  checked after the run.
- **`policy.stopAfter: "reproduce"`** pins a repository to investigation only, so an
  agent can never modify code there.

## Accepted risks, stated plainly

- **Repository configuration executes.** `--setting-sources ""` would sandbox harder,
  but it also blocks `CLAUDE.md`, skills and project conventions — a live run failed
  because the agent could not discover the project used vitest. This is an accepted,
  unmitigated risk, not an oversight.
- **The agent's work is not graded.** An evidence validator existed, passed 8/8 lab
  fixtures, then rejected correct work on three consecutive live issues, and was
  deleted. A human reading the draft PR is the control.

## Supported versions

Only the most recent published version. During pre-alpha there are no backports.
