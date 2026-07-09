# Implementation Task Breakdown

Reference: `PLAN.md`. Status reflects the readiness-review pass: L1-L6 landed, L7 open (has never passed on a fresh checkout — the packaging fixes it depends on landed in this pass), L8 not started.

| # | Task | Owner (heavy-harness role) | AC | Status |
|---|---|---|---|---|
| L1 | Scaffold repo: plugin.json, README, rules/core.md (Iron Laws verbatim + lite phase order + PLAN.md §3 enforcement table) | software-engineer | Plugin installs cleanly; `/lite:` namespace appears | Done |
| L2 | Port + trim 4 agent files per PLAN.md §2 trim rules | software-engineer | Frontmatter valid; no references to instincts/session-memory/advisor | Done |
| L3 | Hooks: copy main-branch-guard, write orchestrator-guard + state-checkpoint + advisory code-shape-check; hooks.json | infrastructure-engineer | Each hook has the 2 fail-closed bats tests (Law 8); all green | Done |
| L4 | STATE.md + plan.md templates; run-state layout under `${CLAUDE_PLUGIN_DATA:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/lite/runs/` | software-engineer | Template fields match PLAN.md §5 exactly | Done |
| L5 | `/lite:build` SKILL.md per PLAN.md §6 | software-engineer | Dry-run on a toy repo produces plan → PR with ≤5 spawns | Done |
| L6 | `/lite:resume` + `/lite:status` + SessionStart notice | software-engineer | Kill session mid-build; resume completes the run from first unchecked task | Done |
| L7 | E2E validation: run a real small idea end-to-end, kill at each phase boundary, resume each time | qa-engineer | All 5 kill-points resume correctly; PR opens; observation line written | In Progress |
| L8 | Review pass on the whole plugin (diff-only) | code-reviewer | APPROVED | Not Started |

## Ordering

- L1 first (everything else references its output).
- L2 / L3 / L4 are parallelizable once L1 lands.
- L5 depends on L2–L4.
- L6 depends on L5.
- L7 is the acceptance gate for the whole plan — do not consider the harness ready until it passes.
- L8 runs last, against the full diff.
