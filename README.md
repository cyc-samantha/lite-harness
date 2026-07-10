# lite-harness

Lightweight Claude Code harness: `/lite:build` runs a defined idea through Plan → Build (TDD) → Test → Review → PR — good-practice code quality, prototype-grade ceremony. It is a companion to, not a replacement for, the full production harness, and it installs the same way — clone into `~/.claude`, run `setup.sh` — not via the plugin marketplace. It intentionally omits intake fingerprinting, Best-of-N/PDR-RTV build variants, the Final Gate quartet, deploy, and the continuous-learning loop (see `PLAN.md` §2 for what was cut and why).

**Status: L1-L6 landed; L7 (E2E validation) in progress.** See `TASKS.md` for per-task status and `PLAN.md` for the full design.

## Prerequisites

- **Claude Code** (no plugin marketplace enrollment needed — see Install below).
- **`jq`** — the hooks parse tool-call JSON with it. Without `jq` the guards degrade to no-ops.
- **`gh`**, authenticated (`gh auth status`) — the final `/lite:build` step opens a PR.
- **`bats`** — only needed to run this repo's test suite (`bats tests/shell/`), not to use the plugin.

## Install

Not distributed via the Claude Code plugin marketplace. Install it the same way as the full production harness: clone straight into your Claude config dir and run the idempotent bootstrap.

```bash
# 1. Clone into your Claude config dir
git clone <repo> ~/.claude

# 2. Run the idempotent bootstrap (checks for required tools, chmods hooks, validates settings.json)
bash ~/.claude/setup.sh
# setup.sh only checks for jq/gh/bats and WARNs if any are missing — it does not
# install them. On macOS, install any missing tools yourself first:
brew install jq gh bats-core
# On Linux / Claude Code Cloud, provision tools with the installer script instead:
bash ~/.claude/scripts/install-tools.sh --yes && bash ~/.claude/setup.sh

# 3. Start Claude Code in any repo and run:
> /lite:build "<a small, well-defined idea>"
```

`settings.json` at the repo root wires the four hooks directly (`hooks/hooks.json` is kept in sync as the plugin-manifest form, for anyone who does prefer to install this repo as a marketplace plugin instead — both forms point at the same hook scripts). The `/lite:` namespace comes from `.claude-plugin/plugin.json`'s `name: "lite"`, which Claude Code honors whether the repo got there via `git clone` or `/plugin install`.

If you already run the heavy harness as your `~/.claude`, don't clone lite-harness on top of it — the two are meant to coexist as separate installs (see `PLAN.md` §7), so add lite-harness as a marketplace plugin in that case, or point `CLAUDE_CONFIG_DIR` at a second config dir for lite-only projects.

Guards (`orchestrator-guard`, `main-branch-guard`) only enforce while a `/lite:build` run is in flight, so installing does not interfere with ordinary interactive work; set `LITE_GUARDS=off` in the environment to force-disable them regardless of run state.

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

```bash
rm -rf ~/.claude
```

(Or, if you installed it as a marketplace plugin instead: `/plugin uninstall lite@lite-harness && /plugin marketplace remove lite-harness`.)

Either way, run state under `.../lite/runs/` is not deleted by removing the harness itself; delete that directory manually if you want a clean slate.

## Running the tests

```
bats tests/shell/
```

Covers the four hooks' Iron-Law-8 fail-closed behavior, run-scoped guard gating, self-locating checkpoints, and the packaging invariants (hooks committed executable, LF-only line endings).
