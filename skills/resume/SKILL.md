---
name: resume
description: /lite:resume — continue a /lite:build run after usage-limit reset, crash, or a killed session. Reads the run's STATE.md, reconciles it against git ground truth, and re-enters skills/build/SKILL.md at the recorded phase. Use when the user runs /lite:resume, optionally with a run slug.
---

# /lite:resume

You are the **orchestrator** resuming an existing `/lite:build` run. Per `rules/core.md` Iron Law 3 you never write source code yourself; you re-enter `skills/build/SKILL.md`'s pipeline and re-spawn exactly the phase's agent that run defines — this skill does not invent a different pipeline, it is a re-entry point into that one.

## Step 1 — Locate the run

- **Slug given** (`/lite:resume <slug>`): read `$CLAUDE_PLUGIN_DATA/runs/<slug>/STATE.md`. If it does not exist, stop and tell the user no such run was found.
- **No slug given**: list `$CLAUDE_PLUGIN_DATA/runs/*/STATE.md`, parse each frontmatter `phase`, discard any with `phase: done`. Among the rest, pick the one with the most recent `created` (or `last_seen` if stamped — prefer `last_seen` since it reflects actual last activity, falling back to `created` when `last_seen` is absent). **Announce which run you picked and why** (e.g. "Resuming run 'photo-dedupe-2026-07-09' — last seen 2026-07-09T10:42:00Z, most recent non-done run.").
- If no non-done STATE.md exists at all, tell the user there is nothing to resume and stop.

## Step 2 — Read state and reconcile against git ground truth

1. Read the full STATE.md (frontmatter + body).
2. Run `git -C <worktree> log --oneline -10` and `git -C <worktree> status`.
3. **Reconcile.** STATE.md's checkboxes (`## Phases`, `## Task breakdown`) are a *claim* written by a previous session; the git log is ground truth. Compare them:
   - If STATE.md checks off a slice/phase but no corresponding commit exists in the log, **git wins**: uncheck it in STATE.md before resuming.
   - If the git log shows commits for a slice/phase STATE.md has NOT checked off (e.g. the checkpoint hook fired before the checkbox was updated), **git wins**: check it off in STATE.md, updating the `(last commit <sha>)` / `(plan.md committed @ <sha>)` annotation to match.
   - If `git status` shows uncommitted changes, note them — the interrupted agent was mid-edit; the resumed agent should either finish that edit or discard it per its own TDD discipline (uncommitted work in a worktree is unrecoverable if abandoned, so prefer finishing over discarding when the change is close to a passing test).
   - Write the corrected STATE.md back before proceeding (STATE.md under `runs/` is Iron-Law-3-allowlisted for direct orchestrator writes).

## Step 3 — Re-enter the pipeline at the recorded phase

Read `skills/build/SKILL.md` for the full step definitions below — this step only maps `phase` to the step to re-enter; it does not restate the spawn contracts.

| STATE.md `phase` | Re-enter at | Notes |
|---|---|---|
| `plan` | Step 3 (Plan) | Re-spawn `planner` with STATE.md + idea. If `plan.md` already exists uncommitted in the worktree, treat it as a draft input to the gate check rather than starting from nothing. |
| `build` | Step 4 (Build) | Re-spawn `software-engineer`. Prompt it with STATE.md, `plan.md`, and the **first unchecked task** in STATE.md's `## Task breakdown` (the line marked `← IN PROGRESS` if present, otherwise the first `- [ ]`). It must not re-do already-committed slices. |
| `test` | Step 5 (Test) | Re-spawn `qa-engineer`. |
| `review` | Step 6 (Review) | Re-spawn `code-reviewer`. If `review_loops` is already at the shared cap (2) and findings remain open in STATE.md, do not spawn again — surface the stall to the user exactly as Step 6's cap-exhausted branch does. |
| `pr` | Step 7 (PR) | Re-attempt PR creation; check first whether a PR already exists for the branch (`gh pr view --head lite/<slug>`) before creating a duplicate. |
| `done` | (nothing to resume) | Should not occur — Step 1 already filters these out. |

Every re-spawned agent's prompt includes: "Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting," plus the reconciled STATE.md contents and a pointer to `plan.md`, exactly as `skills/build/SKILL.md` specifies for that phase's spawn. Continue executing the remaining steps of `skills/build/SKILL.md` in order from the re-entry point through Step 8 (Observation and close-out), including the shared 2-loop fix cap tracked in `review_loops`.

## Step 4 — Recreate a missing worktree

Before spawning anything in Steps 2-3, check `<worktree>` (the path in STATE.md frontmatter) actually exists on disk.

- If it is missing (e.g. machine cleanup wiped `/tmp` or a scratch dir) but `git rev-parse --verify <branch>` (the `branch` field in STATE.md frontmatter) succeeds, **nothing is lost** — the branch carries every committed slice. Recreate at the pinned path convention `.claude/worktrees/<slug>` (matching `skills/build/SKILL.md` Step 2's creation convention, and the only path `orchestrator-guard.sh`'s `/\.claude/worktrees/` backstop matches):
  ```
  git worktree add .claude/worktrees/<slug> <branch>
  ```
  Recreate at the same `worktree` path recorded in STATE.md so the rest of this skill's assumptions (and any relative paths agents were given) still hold. Then proceed with Step 2's reconciliation as normal.
- If the branch itself is also gone, this run cannot be resumed — tell the user and stop; do not fabricate a new branch under the same slug, since that would silently discard the run's history.

## What this skill does NOT do

It does not re-plan a run from scratch, does not skip the git-vs-STATE.md reconciliation "because STATE.md is probably right," and does not spawn any agent outside the four defined in `skills/build/SKILL.md` (`planner`, `software-engineer`, `qa-engineer`, `code-reviewer`). It is a re-entry point, not a second pipeline.
