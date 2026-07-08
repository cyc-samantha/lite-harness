---
name: build
description: /lite:build — the lite harness pipeline entry point. Takes a defined idea and runs it through Plan (planner) -> Build (software-engineer, TDD) -> Test (qa-engineer) -> Review (code-reviewer) -> PR (open, not merge). Use when the user gives /lite:build an idea to implement end-to-end in a prototype-grade way.
---

# /lite:build

You are the **orchestrator** for this run. Per `rules/core.md` Iron Law 3, you never write source code yourself — you coordinate the four lite agents (`planner`, `software-engineer`, `qa-engineer`, `code-reviewer`) and persist only the allowlisted state files (`STATE.md` under `runs/`, and committing agent-authored content on their behalf where the contract below says so).

**Budget contract:** the happy path spawns exactly **5 agents**: planner (1), software-engineer (1), qa-engineer (1), code-reviewer (1), +1 shared fix loop. That fix loop is spent on whichever of software-engineer's two callers (QA gap-fill or review changes-requested) needs it first; a second fix loop is allowed only if the first cap has not already been spent, and the *shared* cap across steps 5+6 is 2 loops total — never spawn a 6th+7th round of software-engineer beyond that cap. Do not spawn a security-review agent, a Final-Gate quartet, or any parallel critic team — those phases do not exist in lite (see `PLAN.md` §2's removal table). This skill has exactly one agent per phase, dispatched **sync, one at a time** — never in parallel.

## Step 1 — Parse the idea

Read the idea from the invocation args (the text after `/lite:build`).

- If the idea names an observable outcome a test could check (a feature, a fix, a behavior), proceed to Step 2.
- If the idea is empty, or is so vague that no test could ever confirm it worked (e.g. "make it better", "improve things"), do not proceed. Ask exactly one clarifying question back to the user, naming what observable outcome is missing, and stop. Do not guess an interpretation and continue.

## Step 2 — Create run state, branch, and worktree

1. Derive `slug` = kebab-case of the idea + today's date (e.g. `photo-dedupe-2026-07-09`).
2. Write `$CLAUDE_PLUGIN_DATA/runs/<slug>/STATE.md` from `templates/STATE.md.tmpl`, filling in `idea`, `repo` (current project root), `branch: lite/<slug>`, `worktree`, `created` (UTC now), `phase: plan`, `review_loops: 0`. This path is allowlisted for the orchestrator (Iron Law 3 exemption: `.md` under `runs/`) — write it directly, do not delegate.
3. Create the branch and worktree from the project's default branch:
   ```
   git branch lite/<slug> <default-branch>
   git worktree add <worktree-path> lite/<slug>
   ```
   Keep it lite: no reaper process, no manifest registry — just the one worktree for this run, removed by the user (or a future cleanup skill) once the PR merges.
4. Set `$LITE_STATE_FILE` and `$LITE_PHASE=plan` in the environment used for subsequent tool calls so `state-checkpoint.sh` stamps the right file on every Stop/SubagentStop.

## Step 3 — Plan (spawn: planner, agent 1/5)

Spawn the `planner` agent (sync, single pass, no worktree — read-only):

> Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting. Idea: "<idea>". Repo: <repo path>. STATE.md contents: <paste current STATE.md>. Produce `plan.md` per `templates/plan.md.tmpl` and your Output Format — 3-7 vertical slices, each with at least one testable AC, file-level design notes grounded in recon citations, failing-test stubs, test strategy, and risks.

**Gate** — before accepting the planner's output, confirm:
- Every slice has ≥1 AC.
- Every AC has a corresponding row in the Failing Test Stubs table (i.e. is testable, not just descriptive).

If the gate fails: re-run the planner **once** with the specific gap named ("slice S3 has no AC" / "AC on S2 has no test stub"). If it fails a second time, stop and surface the gap to the user rather than proceeding with an unplannable slice — do not silently patch the plan yourself (Iron Law 3).

Once the gate passes:
1. Write `plan.md` to `<worktree>/plan.md` and commit it on `lite/<slug>` (`git -C <worktree> add plan.md && git -C <worktree> commit -m "plan: <idea>"`).
2. Update `STATE.md`: check off `- [x] Plan (plan.md committed @ <sha>)`, populate the Task breakdown section with one checkbox per slice, set `phase: build`.

## Step 4 — Build (spawn: software-engineer, agent 2/5)

Spawn `software-engineer` in the worktree:

> Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting. Worktree: <worktree-path>, branch `lite/<slug>`. Plan: `<worktree>/plan.md` (paste or point to it). Implement every slice via TDD (RED -> GREEN -> REFACTOR per your agent contract), committing after each slice goes green.

After the software-engineer returns:
1. Update `STATE.md`'s Task breakdown checkboxes to match what actually got committed (`git -C <worktree> log --oneline` against the slice list) — do not trust a self-report you haven't cross-checked against commits.
2. Move the `phase` to `test`.

If the software-engineer stopped mid-slice (turn limit, crash), this is a resume scenario handled by `/lite:resume`, not by this skill re-spawning inline.

## Step 5 — Test (spawn: qa-engineer, agent 3/5)

Spawn `qa-engineer` in the same worktree:

> Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting. Worktree: <worktree-path>, branch `lite/<slug>`. Plan: `<worktree>/plan.md`. Run the full suite fresh, cross-check every AC, gap-fill test-only gaps, file anything else as a finding.

Read the qa-engineer's verdict:
- **`GAPS_CLOSED`** — record the fresh pass/fail counts in `STATE.md` (this is the test evidence for the PR body), set `phase: review`, proceed to Step 6.
- **`GAPS_FOUND`** — append the findings to `STATE.md` § Open findings. This consumes one fix loop (see the shared cap below). Spawn `software-engineer` again (agent 4/5, the "+1 fix loop") with the findings and plan.md, addressing each finding. Re-run qa-engineer's suite check is not required a second time in the happy-path budget — trust the software-engineer's own fresh-verification self-review (its agent contract requires this) before moving to Review with the fix applied.

## Step 6 — Review (spawn: code-reviewer, agent 4/5 or 5/5)

Spawn `code-reviewer` (read-only, no worktree) on the diff:

> Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting. Review `git diff <default-branch>...lite/<slug>` in <repo/worktree path>. Cross-check findings against `STATE.md` § Open findings already resolved.

Read the verdict:
- **`APPROVE`** — set `phase: pr`, proceed to Step 7.
- **`CHANGES_REQUESTED`** — check the shared loop counter in `STATE.md`'s `review_loops` frontmatter field:
  - If `review_loops < 2` (counting both this loop and any QA fix loop already spent in Step 5): increment `review_loops`, spawn `software-engineer` once more with the reviewer's findings, then re-spawn `code-reviewer` to re-check the diff.
  - If the cap is already spent (this would be the 3rd total fix loop across Steps 5+6): **STOP.** Do not spawn another software-engineer round. Write the outstanding `CHANGES_REQUESTED` findings into `STATE.md` § Open findings, set `phase` to reflect the stall (leave at `review`), and surface to the user: which findings remain open and that the 2-loop cap (Iron Law 6's escape hatch) has been reached. End the skill run here — do not proceed to Step 7.

This means the happy-path spawn count is: planner (1) + software-engineer build (1) + qa-engineer (1) + code-reviewer (1) + at most one more software-engineer/code-reviewer pass shared between Steps 5-6 = **≤5 spawns total**, matching the PLAN.md §6 budget.

## Step 7 — PR

From the worktree, open (never merge) a pull request:

```
gh pr create --base <default-branch> --head lite/<slug> --title "<idea, one line>" --body "<body below>"
```

PR body must include, freshly composed from this run (not copy-pasted from an earlier draft):
- The idea, one line.
- A short plan summary (slice list from `plan.md`).
- Test evidence: the qa-engineer's fresh pass/fail counts from Step 5 (Iron Law 2 — no stale numbers).
- The final review verdict from Step 6 (`APPROVE`, with the loop count it took).

Update `STATE.md`: check off `- [x] PR`, note the PR URL/number, set `phase: pr` if not already set.

## Step 8 — Observation and close-out

Append exactly one JSONL line to `$CLAUDE_PLUGIN_DATA/observations.jsonl` (create the file if absent, append-only, never rewrite prior lines):

```json
{"ts": "<UTC now>", "idea": "<idea>", "phases": ["plan","build","test","review","pr"], "loops": <review_loops final value>, "outcome": "<pr_opened | stopped_at_loop_cap | blocked_at_plan>"}
```

Set `STATE.md`'s `phase: done` (or leave it at the stalled phase from Step 6 if the run stopped early — in that case `outcome` above is `stopped_at_loop_cap`, not `pr_opened`, and this step still runs: an observation is written for every run, per Iron Law 7, success or not).

## What this skill does NOT do

Per `PLAN.md` §2's removal table, none of the following ever appear in this flow: `/harness:intake` T0-T6 fingerprinting, architect-context-recon or plan-cache agents, Best-of-N or PDR-RTV build variants, a standalone security-review phase (folded into code-reviewer's checklist instead), the Final Gate quartet (patch-critic, spec-blind-validator, vlm-critic, product-reviewer), deploy/multi-repo/manifest steps, or continuous-learning/instinct-injection/session-memory-adapter machinery. If you find yourself about to spawn an agent not named in Steps 3-6, stop — it does not belong in `/lite:build`.
