# Implementation Task Breakdown

Reference: `PLAN.md`. **Do not start any task until the repo owner explicitly approves implementation.**

| # | Task | Owner (heavy-harness role) | AC |
|---|---|---|---|
| L1 | Scaffold repo: plugin.json, README, rules/core.md (Iron Laws verbatim + lite phase order + PLAN.md §3 enforcement table) | software-engineer | Plugin installs cleanly; `/lite:` namespace appears |
| L2 | Port + trim 4 agent files per PLAN.md §2 trim rules | software-engineer | Frontmatter valid; no references to instincts/session-memory/advisor |
| L3 | Hooks: copy main-branch-guard, write orchestrator-guard + state-checkpoint + advisory code-shape-check; hooks.json | infrastructure-engineer | Each hook has the 2 fail-closed bats tests (Law 8); all green |
| L4 | STATE.md + plan.md templates; `$CLAUDE_PLUGIN_DATA/runs/` layout | software-engineer | Template fields match PLAN.md §5 exactly |
| L5 | `/lite:build` SKILL.md per PLAN.md §6 | software-engineer | Dry-run on a toy repo produces plan → PR with ≤5 spawns |
| L6 | `/lite:resume` + `/lite:status` + SessionStart notice | software-engineer | Kill session mid-build; resume completes the run from first unchecked task |
| L7 | E2E validation: run a real small idea end-to-end, kill at each phase boundary, resume each time | qa-engineer | All 5 kill-points resume correctly; PR opens; observation line written |
| L8 | Review pass on the whole plugin (diff-only) | code-reviewer | APPROVED |

## Ordering

- L1 first (everything else references its output).
- L2 / L3 / L4 are parallelizable once L1 lands.
- L5 depends on L2–L4.
- L6 depends on L5.
- L7 is the acceptance gate for the whole plan — do not consider the harness ready until it passes.
- L8 runs last, against the full diff.
