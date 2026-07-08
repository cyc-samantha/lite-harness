---
name: status
description: /lite:status — read-only report of one or all /lite:build runs. Takes an optional slug ("all" or no argument means every run). Prints idea, phase, task breakdown progress, open findings count, review_loops, and last_seen. Never mutates state, never spawns agents.
---

# /lite:status

You are reporting on run state, not orchestrating anything. This skill is **purely observational**: it reads `STATE.md` file(s) and prints a summary. It never writes to STATE.md, never runs a git command that changes anything, and never spawns an agent.

## Step 1 — Resolve which run(s) to report on

- **A slug is given**: report on `$CLAUDE_PLUGIN_DATA/runs/<slug>/STATE.md` only. If it does not exist, say so and stop.
- **`all` or no argument**: report on every `$CLAUDE_PLUGIN_DATA/runs/*/STATE.md` that exists, most-recently-active first (sort by `last_seen` if present, else `created`).
- If `$CLAUDE_PLUGIN_DATA/runs/` has no runs at all, print "No lite runs found." and stop.

## Step 2 — For each STATE.md, extract and print

Read the file (frontmatter + body) and report, one block per run:

```
Run: <slug>
Idea: <idea>
Phase: <phase>
Task breakdown: <N>/<M> slices done — in progress: <the task line marked ← IN PROGRESS, or "none" if all done or none started>
Open findings: <count of non-"(none)" bullet lines under ## Open findings>
Review loops used: <review_loops>/2
Last seen: <last_seen, or "never (not yet checkpointed)" if the key is absent>
```

Derive each field directly from the file — do not infer or guess a field that isn't present:
- `N`/`M`: count `- [x]` vs total `- [ ]`+`- [x]` lines under `## Task breakdown`.
- "in progress" line: the task-breakdown line containing `← IN PROGRESS`, verbatim.
- Open findings count: number of bullet lines under `## Open findings` that are not literally `- (none)`.
- `review_loops`: the frontmatter value as-is.
- `last_seen`: the frontmatter value if present; the key is written by `hooks/state-checkpoint.sh` on first Stop/SubagentStop, so a run that has never stopped yet won't have it — report that plainly rather than guessing a value.

## Step 3 — No mutation, ever

This skill must not: write to any STATE.md, run `git add`/`commit`/`checkout` or any other mutating git command, spawn `planner`/`software-engineer`/`qa-engineer`/`code-reviewer`, or touch `$CLAUDE_PLUGIN_DATA/observations.jsonl`. Read-only `git -C <worktree> log`/`status` calls are fine if you want to cross-check a run's claimed progress for the report, but do not act on any discrepancy found here — that reconciliation belongs to `/lite:resume`, not `/lite:status`. If you notice STATE.md's claim looks stale against git, you may mention it in the printed report as a note, but you do not correct the file.
