# Lite Harness — Implementation Plan (v1)

**Status:** L1-L6 landed; L7 (E2E validation) in progress — see `TASKS.md` for per-task status. This document is the design of record; the plugin now implements it (agents, skills, hooks, templates all in place).

**Audience:** the current harness agent team (orchestrator + Opus/Sonnet agents) who will build this.
**Goal:** a lightweight prototype-grade pipeline: when an idea is already defined, build it safely and fast — agile task breakdown → Plan → Build (SE, TDD) → Test (QE) → PR review — with best-practice code quality (DRY, YAGNI, SOLID, small functions) but *without* the production-grade ceremony (intake fingerprinting, Best-of-N, PDR-RTV, Final Gate quartet, learning loop, eval suite).
**Non-goal:** replacing the heavy harness. The two coexist; the heavy harness repo (`~/.claude` / `git/.claude`) is NOT touched.

---

## 1. Delivery mechanism: a Claude Code plugin in a new repo

Ship the lite harness as a **Claude Code plugin** (this repo, `lite-harness`). Rationale:

- Plugins bundle `agents/`, `skills/`, `hooks/`, `commands/` and are **namespaced** (`/lite:build`), so nothing collides with the installed heavy harness in `~/.claude`.
- Install/uninstall is one command; the heavy harness repo stays untouched.
- Per-project opt-in is possible (enable the plugin only in prototype repos).

### Repo layout

```
lite-harness/
├── .claude-plugin/
│   └── plugin.json            # name: "lite", version, description
├── agents/
│   ├── planner.md             # trimmed from heavy architect.md
│   ├── software-engineer.md   # trimmed from heavy software-engineer.md
│   ├── qa-engineer.md         # trimmed from heavy qa-engineer.md
│   └── code-reviewer.md       # trimmed from heavy code-reviewer.md (+ security checklist folded in)
├── skills/
│   ├── build/SKILL.md         # /lite:build — the whole pipeline, entry point
│   ├── resume/SKILL.md        # /lite:resume — continue after usage-limit / crash
│   └── status/SKILL.md        # /lite:status — show run state, phase, open tasks
├── hooks/
│   ├── hooks.json             # ≤ 6 hook registrations (vs ~90 in heavy)
│   ├── main-branch-guard.sh   # copied from heavy harness (Iron Law 4)
│   ├── orchestrator-guard.sh  # trimmed orchestrator-discipline.sh (Iron Law 3)
│   ├── state-checkpoint.sh    # Stop/SubagentStop hook — writes run state (memory/resume)
│   └── code-shape-check.sh    # copied, ADVISORY mode only (warn, never exit 2)
├── rules/
│   └── core.md                # Iron Laws (verbatim, see §3) + code shape rules + lite phase order
├── templates/
│   ├── STATE.md.tmpl          # run-state file template (see §5)
│   └── plan.md.tmpl           # planner output template (task breakdown format)
├── tests/
│   └── shell/                 # bats tests for the 4 hooks (fail-closed tests per Iron Law 8)
└── README.md                  # install + usage (see §7)
```

---

## 2. Pipeline design

### Phase order (lite)

```
Plan (breakdown + design, one agent) → Build (SE, TDD, worktree) → Test (QE, same worktree)
→ Review (code-reviewer, diff-only, security checklist included) → PR (open, not merge)
```

What was **removed** relative to heavy, and why it's safe for prototypes:

| Heavy phase / feature | Lite disposition | Rationale |
|---|---|---|
| `/harness:intake` T0–T6 fingerprint | **Dropped.** `/lite:build` assumes T4/T5-shaped defined work | Idea is already defined; no routing needed |
| architect-context-recon, plan-cache, plan validation team | **Dropped.** Planner does one recon-lite read pass itself | Biggest token sink; a defined idea doesn't need multi-agent brainstorm |
| Best-of-N / PDR-RTV build variants | **Dropped** | Prototype needs one good implementation, not N |
| Separate Security Review phase (security-engineer) | **Folded into reviewer checklist** (OWASP-top-level items: injection, secrets in diff, authz on new endpoints) | Advisory for prototypes; escalate to heavy harness before productionizing |
| Final Gate (patch-critic, spec-blind-validator, vlm-critic, product-reviewer) | **Dropped.** QE pass + review is the gate | 4 parallel Opus/Sonnet spawns is the heaviest step in heavy pipeline |
| Deploy / multi-repo / manifests | **Dropped.** Pipeline ends at open PR | Prototypes ship by human merge |
| Continuous learning, instinct injection, eval suite, metrics | **Dropped**, except one-line observation append (Iron Law 7, see §3) | The learning loop is the long-tail token cost |
| Advisor-mode (Opus advisor pairing) | **Dropped.** Sonnet-solo everywhere except planner | It's advisory-not-enforced in heavy anyway |

### Agent roster (4 agents, all with `tools:` allowlists)

| Agent | Model | Worktree | Role |
|---|---|---|---|
| planner | opus (`model: opus`, no conditional) | No (read-only) | Reads repo, produces `plan.md`: agile task breakdown (vertical slices, each with ACs), file-level design notes, test strategy stub. Single pass, `maxTurns: 40`. |
| software-engineer | sonnet | **Yes — mandatory** | TDD per task: failing test → implement → green → commit per slice (`WIP:`/conventional commits). `maxTurns: 100`. |
| qa-engineer | sonnet | Yes (same worktree branch) | Runs full suite, adds missing edge-case/integration tests for ACs, fixes flaky setup. Does NOT rewrite implementation — files findings to state file for SE fix loop. |
| code-reviewer | sonnet | No (read-only, diff-only) | Correctness + code-shape + folded security checklist. Verdicts: `APPROVED` / `CHANGES_REQUESTED` (max 2 fix loops back to SE, then escalate to user). |

Trim rules when porting agent .md files from heavy: keep frontmatter `name/description/tools/model/maxTurns/disallowedTools`; **delete** `advisor`, `model_conditional`, `instinct_categories`, `memory:` fields and all references to scratchpad/instincts/session-memory adapters. Every spawn prompt includes: "Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and the run's `STATE.md` before starting."

---

## 3. Iron Laws — kept verbatim, enforcement rescoped

All 8 Iron Laws from heavy `rules/core.md` copy into lite `rules/core.md` **unchanged in text**. Enforcement status in lite:

| Law | Lite status |
|---|---|
| 1 — AC needs failing-then-passing test (mutation ≥70%) | ASPIRATIONAL (as in heavy). Failing-then-passing test: **required by SE procedure**; mutation gate: not shipped (no mutation hook) |
| 2 — fresh verification evidence | ASPIRATIONAL; QE re-runs suite as last act before Review |
| 3 — orchestrator never writes source | **ENFORCED** via `orchestrator-guard.sh` (port `is-protected-path.sh` logic; allowlist: `STATE.md`, `pipeline-state/`) |
| 4 — HEAD stays on main; worktree delegation | **ENFORCED** via copied `main-branch-guard.sh` |
| 5 — no phase skipped | ASPIRATIONAL; lite defines 5 phases (§2), `/lite:build` runs all 5, `STATE.md` checkboxes prove it |
| 6 — review findings fixed in-pipeline | KEPT; the 2-loop SE fix cycle implements it |
| 7 — every pipeline produces an observation | KEPT, minimal: orchestrator appends one JSONL line (`{ts, idea, phases, loops, outcome}`) to `$CLAUDE_PLUGIN_DATA/observations.jsonl`. No processing loop consumes it — capture only. |
| 8 — gates fail closed | **ENFORCED**: each of the 4 shipped hooks gets the two required bats tests (revert-goes-RED + unevaluable-input-refuses) |

Code Shape Rules copy verbatim too, but `code-shape-check.sh` runs **advisory** (warn text, exit 0) — the reviewer enforces shape at Review instead of blocking every edit. This is the main "speed" concession and it does not lower the standard, only moves enforcement later.

---

## 4. Procedure: reducing a function/agent from the heavy harness (reusable checklist)

When the repo owner later wants to remove *more* from either harness, the agent team follows this:

1. **Reference sweep:** `grep -r "<agent-or-hook-name>"` across `skills/`, `hooks/hooks.json`, `CLAUDE.md`, `rules/`, `protocols/`, `tests/`. Every hit is a removal site.
2. **Classify each hit:** dispatch site (skill spawns it) / enforcement site (hooks.json matcher) / documentation (tables in CLAUDE.md) / test pin (e.g. heavy's `tests/test_claude_md_agent_table.py`).
3. **Remove in one commit:** agent .md + hooks.json matcher + skill dispatch step + doc table row + its tests. Never leave a dangling spawn instruction — an orchestrator that's told to spawn a missing agent stalls the pipeline.
4. **Check Iron Law impact:** if the removed piece was the enforcement surface of an ENFORCED law, either (a) keep the law and downgrade its tag to ASPIRATIONAL in the same commit, or (b) don't remove it. Never leave a law claiming ENFORCED with no hook behind it.
5. **Run the hook/bats test suite**; add a changelog line.

---

## 5. Memory & resume (usage-limit survival) — the core new requirement

Design principle: **all durable state lives in git-committed artifacts + one state file**, so a brand-new session with zero context can resume.

### Run state file

Every `/lite:build` creates `$CLAUDE_PLUGIN_DATA/runs/<slug>/STATE.md` (slug = kebab of idea + date):

```markdown
---
idea: "<one-line idea>"
repo: <path>
branch: lite/<slug>
worktree: <path>
created: 2026-07-08T10:00:00Z
phase: build          # plan | build | test | review | pr | done
review_loops: 0
---
## Phases
- [x] Plan      (plan.md committed @ <sha>)
- [ ] Build     (task 3/5, last commit <sha>)
- [ ] Test
- [ ] Review
- [ ] PR

## Task breakdown  (from plan.md, checkbox per slice)
- [x] T1: <slice> — AC: ...
- [x] T2: ...
- [ ] T3: ...   ← IN PROGRESS: <one line of where SE stopped>

## Open findings (QE/reviewer → SE)
- (none)

## Decisions log
- <date>: chose X over Y because ...
```

### Write discipline (this is what makes resume work)

- **Orchestrator** updates `STATE.md` at every phase boundary (allowlisted for Law 3).
- **SE commits per task slice** (`WIP:` allowed) — an interrupted build loses at most one slice.
- **`state-checkpoint.sh`** (Stop + SubagentStop hook): on every stop, stamps `last_seen` + current phase into STATE.md frontmatter. Cheap (one sed), fail-closed-tested.
- **plan.md is committed to the worktree branch**, not just kept in context — the plan survives compaction and session death.

### Resume flow

`/lite:resume [slug]`:
1. No slug → list `$CLAUDE_PLUGIN_DATA/runs/*/STATE.md` where `phase != done`, pick most recent (announce which).
2. Read STATE.md + `git -C <worktree> log --oneline -10` + `git status`.
3. Re-enter the pipeline at the recorded phase, re-spawning the phase's agent with STATE.md + plan.md in the prompt. Mid-build → SE resumes at first unchecked task.
4. If the worktree is gone (machine cleanup), recreate it from `branch` — the branch has all commits.

Also register a lightweight SessionStart hook that prints (does not auto-invoke): `"Lite run '<slug>' is in <phase> — run /lite:resume to continue."` Printing instead of auto-resuming keeps startup cheap and leaves control with the user.

---

## 6. `/lite:build` skill — orchestration contract (summary for SKILL.md)

1. Parse idea from args; refuse with a one-question ask only if the idea has no testable outcome at all.
2. Create STATE.md; create branch `lite/<slug>` + worktree (reuse heavy's worktree-create pattern, `git worktree add`).
3. **Plan:** spawn planner (sync). Output = `plan.md` (template §1) with 3–7 vertical-slice tasks, each with ACs. Commit plan.md to the branch. Gate: every task has ≥1 AC, every AC is testable. Update STATE.
4. **Build:** spawn SE with plan.md; TDD per task; commit per slice. Update STATE per task.
5. **Test:** spawn QE; full suite + AC coverage check; findings → STATE `Open findings`.
   - Findings present → spawn SE fix loop (counts toward the 2-loop cap shared with review).
6. **Review:** spawn code-reviewer on `git diff main...branch`. `CHANGES_REQUESTED` → SE fix loop (max 2 total, then STOP and surface to user — Iron Law 6 escape hatch).
7. **PR:** `gh pr create` from the worktree (never merge). Body: idea, plan summary, test evidence (fresh run output — Law 2), review verdict.
8. Append observation JSONL (Law 7). Mark STATE `done`.

Token budget target: **≤ 5 agent spawns on the happy path** (planner, SE, QE, reviewer, +1 fix loop) vs heavy's ~12–15. All Sonnet except planner.

---

## 7. Install & usage (goes in README.md)

```bash
# one-time
git clone <this-repo-url> ~/git/lite-harness
claude
> /plugin marketplace add ~/git/lite-harness
> /plugin install lite@lite-harness

# per idea, from the target project repo:
> /lite:build "CLI tool that dedupes photos by perceptual hash, with a dry-run mode"

# after usage limit resets / new session:
> /lite:resume            # picks up the most recent unfinished run
> /lite:status            # where am I?
```

Both harnesses coexist: heavy stays global in `~/.claude`; heavy hooks (main-branch-guard etc.) firing during lite runs is harmless — lite obeys the same worktree discipline, so no conflicts. If you want lite-only projects, disable heavy per-project via project settings.

---

## 8. Task breakdown for the agent team (implementation order)

See `TASKS.md` for the pickup-ready checklist (L1–L8) with owners and ACs.
