# Core Invariants (lite)

Always-loaded by every lite agent on every spawn. Ported from the heavy harness's `rules/core.md`; enforcement is rescoped for a prototype-grade pipeline per `PLAN.md` §3 — the law text itself is unchanged.

## Iron Laws

These are absolutes. No exceptions. No "just this once."

1. [ASPIRATIONAL] **NO ACCEPTANCE CRITERION SHIPS WITHOUT (a) a failing-then-passing test for that AC in the diff and (b) mutation score ≥ 70% on changed lines.** Lite status: the failing-then-passing test is required by the SE procedure; the mutation-score gate is not shipped (no mutation hook in lite).
2. [ASPIRATIONAL] **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.** Stale test output from earlier in the session is not evidence — re-run before claiming done. Lite status: QE re-runs the full suite as its last act before Review.
3. [ENFORCED] **THE ORCHESTRATOR NEVER WRITES SOURCE CODE.** The orchestrator coordinates agents; it does not Edit, Write, or shell-pipe into protected locations. Lite status: enforced via `hooks/orchestrator-guard.sh` (ported from heavy's `is-protected-path.sh` logic); allowlist: `STATE.md`, `pipeline-state/`.
4. [ENFORCED] **REPO_ROOT HEAD STAYS ON `main` FOR THE ENTIRE DURATION OF EVERY PIPELINE RUN.** All HEAD-mutating git commands run via worktree delegation. Lite status: enforced via `hooks/main-branch-guard.sh` (copied from heavy).
5. [ASPIRATIONAL] **NO PHASE SKIPPED. NO GATE BYPASSED. NO SKILL OMITTED.** Every pipeline phase runs the corresponding skill; verdicts gate advancement. Lite status: lite defines 5 phases (see § Phase Order below); `/lite:build` runs all 5; `STATE.md` checkboxes are the evidence.
6. [KEPT] **FINDINGS SURFACED DURING REVIEW ARE FIXED IN THIS PIPELINE.** Never filed as follow-ups. Never surfaced as questions to the user. Lite status: the 2-loop SE fix cycle (shared cap across QE findings and reviewer `CHANGES_REQUESTED`) implements this; exceeding the cap stops the pipeline and surfaces to the user.
7. [KEPT] **EVERY PIPELINE PRODUCES AN OBSERVATION.** No exceptions — successes and failures both. Lite status: kept, minimal — the orchestrator appends one JSONL line (`{ts, idea, phases, loops, outcome}`) to `$CLAUDE_PLUGIN_DATA/observations.jsonl`. No processing loop consumes it in lite — capture only.
8. [ENFORCED] **A SECURITY OR CORRECTNESS GATE THAT CANNOT EVALUATE ITS CONDITION FAILS CLOSED.** A gate is any check whose verdict admits or stops work — a hook, a pipeline phase verdict, a guard clause on a protected operation. When a gate hits an unevaluable input — empty input, missing file, unbound variable, tool error, or absent dependency — it must halt or refuse to proceed, never silently allow. Lite status: enforced — each of the 4 shipped hooks (`main-branch-guard.sh`, `orchestrator-guard.sh`, `state-checkpoint.sh`, `code-shape-check.sh`) ships the two required bats tests: (a) revert-goes-RED (proves the test exercises the gate) and (b) unevaluable-input-refuses.

## Code Shape Rules (advisory in lite)

Enforced continuously by heavy; in lite, `hooks/code-shape-check.sh` runs **advisory only** (warns, exits 0) — the code-reviewer enforces shape at the Review phase instead of blocking every edit. This moves enforcement later; it does not lower the standard.

- **Naming is the primary cohesion gate:** can't name a unit without "and" → split; can't give an extract an honest name → do NOT extract.
- **Function line limits:** Ruby methods > 5 lines, TypeScript/JS functions > 12 lines are flagged. Python/Go use the same fallback cap.
- **One thing per function.** If you cannot name it without a conjunction ("X and Y"), split.
- **Cyclomatic complexity ≤ 5.** Nesting ≤ 2 — guard clauses or extraction, not deeper if/else.
- **DRY on 2nd occurrence.** Extract immediately when logic recurs.
- **≤ 4 params** per function. More signals a missing abstraction.
- **Single public entry point** per class (`.call`/`.run`/`.execute`).

## Phase Order (lite)

```
Plan (planner, one pass) → Build (software-engineer, TDD, worktree) → Test (qa-engineer, same worktree)
→ Review (code-reviewer, diff-only, folded security checklist) → PR (open, not merge)
```

No Final Gate quartet, no separate Security Review phase, no deploy step — see `PLAN.md` §2 for the full removed-relative-to-heavy table and rationale. Every run's progress against these 5 phases is tracked in that run's `STATE.md`.

## Where to Look Next

| Need | File |
|------|------|
| Full pipeline design, agent roster, memory/resume model | `PLAN.md` |
| Implementation pickup order (L1–L8) | `TASKS.md` |
| Install + usage | `README.md` |
