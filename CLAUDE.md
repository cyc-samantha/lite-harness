# Working on lite-harness itself

This file governs work **on** this repository. It is not loaded into the runs this
harness executes — those get `rules/core.md`, which is budgeted and tested.

**The playbook in a parent directory does not apply here.** A `CLAUDE.md` above
this one describes a different harness: a pipeline of phases, an agent roster, and
`/harness:*` skills, none of which exist in this repository. This repository is the
alternative to that design, not an instance of it. Where the two disagree, this
file wins.

## What this is

An execution layer. A sealed work contract goes in; a branch with evidence for
every acceptance criterion comes out. It never decides whether the work is done —
it produces evidence, and the work source adjudicates. See `README.md`.

## The three documents, and which one to edit

| File | Read by | Loaded |
|---|---|---|
| `README.md` | someone adopting the harness | never automatically |
| `rules/core.md` | an agent running a contract in a **target** repo | every spawn — 6 KB cap, enforced |
| `CLAUDE.md` | an agent working on **this** repo | on open |

Putting repository-development advice in `rules/core.md` spends the always-loaded
budget on something no run needs. Putting run rules here means runs never see them.

## Commands

```bash
npm run check      # typecheck + 56 unit tests
bats tests/shell/  # 58 hook tests
```

`.ts` runs directly under Node's type stripping — there is no build step, and
adding one would be a regression.

## Rules that are not visible in the code

- **The engine imports no adapter and names no project.** Wiring belongs in
  `bin/lite.ts`, the composition root. `tests/anti-entropy/engine-purity.test.ts`
  enforces this.
- **When an anti-entropy test fails, fix the code — never the threshold.** Each of
  the three exists because the pressure it resists is invisible in the moment and
  irreversible in aggregate. `engine/cli.ts` once imported the adapter and
  hardcoded a host; the fix was moving it to `bin/lite.ts`, not relaxing the test.
- **No new runtime dependency without asking.** It is a supply-chain decision.
- **Never `git add -A`.** Stage named paths.
- **A hook must be committed executable.** `core.filemode=false` on WSL means
  `chmod` never reaches the index, and the launcher's `[ -x "$h" ] && exec "$h"`
  then silently skips every guard — a disabled security control that looks fine.
  Use `git update-index --chmod=+x`; `tests/shell/test_hooks_executable.bats`
  catches it.
- **Every gate ships two tests**: one that goes red when its fail-closed line is
  reverted, and one that feeds it unevaluable input and asserts it refuses.

## Working style here

Small commits on a branch off `main`, merged locally. No pull request — this
repository is the tool, not work the tool executes.
