# issueforge

## 0.1.0-alpha.4

### Minor Changes

- fc7fa82: Coloured, correctly-aligned terminal output, and live progress while a run works.
  
  `status`, `doctor`, `clean` and `cancel` now size their columns by MEASURED display
  width rather than `.length`, so a CJK repository name or an emoji no longer ragged
  every column after it. Text that came from a GitHub issue is stripped of control
  characters before it is printed — a crafted issue title containing `\r` could
  previously overwrite the line above it.
  
  `issueforge run` shows what it is doing while it does it: each stage is committed to
  scrollback as it completes, with a live row for the current one. A run took minutes and
  printed nothing until it finished, so a slow run and a hung one looked identical.
  
  Colour turns itself off for a pipe, for CI, and for `NO_COLOR`; `--no-color` forces it
  off and `FORCE_COLOR` forces it on. `--json` output is unchanged and carries no
  decoration.

### Patch Changes

- a719a89: Explain an unreachable repository in one sentence instead of echoing five lines of
  git output, and point new users at the local `run` before the self-hosted runner
  setup.

## 0.1.0-alpha.3

### Patch Changes

- 88e62ff: Report the version injected from the manifest at build time, rather than a
  hand-written constant that a release had to remember to edit.
