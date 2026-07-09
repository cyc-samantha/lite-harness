# lite-harness

Lightweight Claude Code plugin: `/lite:build` runs a defined idea through Plan → Build (TDD) → Test → Review → PR — good-practice code quality, prototype-grade ceremony. It is a companion to, not a replacement for, the full production harness; it intentionally omits intake fingerprinting, Best-of-N/PDR-RTV build variants, the Final Gate quartet, deploy, and the continuous-learning loop (see `PLAN.md` §2 for what was cut and why).

**Status: L1-L6 landed; L7 (E2E validation) in progress.** See `TASKS.md` for per-task status and `PLAN.md` for the full design.

## Prerequisites

- **Claude Code** with plugin support.
- **`jq`** — the hooks parse tool-call JSON with it. Without `jq` the guards degrade to no-ops.
- **`gh`**, authenticated (`gh auth status`) — the final `/lite:build` step opens a PR.
- **`bats`** — only needed to run this repo's test suite (`bats tests/shell/`), not to use the plugin.

## Install

The plugin is distributed as a Claude Code marketplace whose manifest is `.claude-plugin/marketplace.json` (marketplace name `lite-harness`, plugin name `lite`).

From a local clone:

```
/plugin marketplace add /absolute/path/to/lite-harness
/plugin install lite@lite-harness
```

Or straight from the git URL:

```
/plugin marketplace add https://github.com/<owner>/lite-harness
/plugin install lite@lite-harness
```

Enablement is per-project: enable the `lite` plugin in each project where you want the `/lite:` commands and the run-scoped guards active. The guards (`orchestrator-guard`, `main-branch-guard`) only enforce while a `/lite:build` run is in flight, so enabling the plugin does not interfere with ordinary interactive work; set `LITE_GUARDS=off` in the environment to force-disable them regardless of run state.

## Usage

Three user commands:

- `/lite:build "<idea>"` — run a defined idea end-to-end: Plan (planner) → Build (software-engineer, TDD) → Test (qa-engineer) → Review (code-reviewer) → PR (opened, never merged). The happy path spawns ≤5 agents.
- `/lite:resume [<slug>]` — continue a run after a usage-limit reset, crash, or killed session. With no slug it picks the most-recently-active non-done run. Reconciles `STATE.md` against git ground truth, then re-enters the pipeline at the recorded phase.
- `/lite:status [<slug>|all]` — read-only report of one or all runs (phase, task progress, open findings, review loops, last seen). Never mutates state, never spawns agents.

## Where run state lives

Per-run bookkeeping is written to a per-machine, non-git-tracked location resolved through this fallback chain (Claude Code sets `CLAUDE_PLUGIN_ROOT` but not `CLAUDE_PLUGIN_DATA` for plugins, so the fallback is mandatory — see `hooks/_lib/lite-paths.sh`):

```
${CLAUDE_PLUGIN_DATA:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/lite/runs/<slug>/STATE.md
```

`STATE.md` is ephemeral orchestration state; the run's durable deliverable, `plan.md`, is committed to the run's `lite/<slug>` branch instead. See `templates/README.md` for the split and `PLAN.md` §5 for the resume model.

## Uninstall

```
/plugin uninstall lite@lite-harness
/plugin marketplace remove lite-harness
```

Removing the plugin does not delete run state under `.../lite/runs/`; delete that directory manually if you want a clean slate.

## Running the tests

```
bats tests/shell/
```

Covers the four hooks' Iron-Law-8 fail-closed behavior, run-scoped guard gating, self-locating checkpoints, and the packaging invariants (hooks committed executable, LF-only line endings).
