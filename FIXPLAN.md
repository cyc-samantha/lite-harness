# lite-harness — Audit Fix Plan (2026-07-09)

**Audience:** harness agent team. **Goal:** one final PR closing the audit findings below.
**Install method is unchanged:** idempotent bootstrap (`git clone → setup.sh`), NOT the plugin marketplace.

Audit basis: full read of `setup.sh`, `scripts/install-tools.sh`, all four hooks + `hooks/_lib/lite-paths.sh`, `settings.json` / `hooks/hooks.json`, the three skills, four agents, templates; bats suite run (43/43 pass); hook `timeout` semantics verified against the current Claude Code hooks docs (https://code.claude.com/docs/en/hooks).

---

## Findings and fixes (ordered; 1–4 gate the PR, 5–7 fold in)

### 1. S1 — Hook `timeout` values use the wrong unit — **High**
- **Where:** `settings.json` and `hooks/hooks.json` (all five registrations).
- **Defect:** `"timeout": 5000` / `10000` were authored as milliseconds, but the hooks schema defines `timeout` in **seconds** (default 600). `5000` = ~83 minutes — a wedged guard hook stalls a tool call for over an hour instead of failing fast in 5s.
- **Fix:** `5000 → 5`, `10000 → 10`, in **both** files.
- **Test (AC):** new bats test asserting every `timeout` value in both files is `<= 30`.
- **Caveat:** derived from the live published schema. If the pinned target Claude Code version historically accepted milliseconds, verify against that version first — but current docs are unambiguous (seconds).

### 2. S2 — `main-branch-guard.sh` accepts REPO_ROOT as a "worktree" — **High (Iron Law 4 bypass)**
- **Where:** `hooks/main-branch-guard.sh::has_valid_delegation` (and the forbidden-command regex).
- **Defect:** any non-empty `cd`/`-C`/`--git-dir` target counts as valid delegation. Confirmed-by-source bypasses:
  - `cd <repo-root> && git checkout main` — detected as forbidden but allowed (non-empty `cd` target).
  - `git -C . checkout main` — not even detected (`-C .` breaks the `git checkout` regex), and `.` is REPO_ROOT.
- **Why lite can fix what heavy documents as a known limitation:** lite **pins** the worktree convention to `.claude/worktrees/<slug>` (`skills/build/SKILL.md` Step 2), so the target is checkable.
- **Fix:** in `has_valid_delegation`, extract the delegation target for all three prefixes and require it to contain `.claude/worktrees/` (reject `.`, empty, and REPO_ROOT). Also handle intervening `git` global flags (e.g. `--work-tree=`) in the forbidden-command regex so flagged forms are still detected.
- **Tests (AC):** blocked: `git -C . checkout …`, `cd <repo-root> && git checkout …`, `git --work-tree=/x checkout …`. Allowed (unchanged): `git -C …/.claude/worktrees/wt checkout …`, `cd "$WORKTREE" && git merge …`. Keep both existing Iron-Law-8 fail-closed tests green.

### 3. S3 — `orchestrator-guard.sh` trusts any non-empty `CLAUDE_SUBAGENT_TYPE` — **Medium**
- **Where:** `hooks/orchestrator-guard.sh` line ~51 (env fallback) → line ~89 (unconditional pass-through).
- **Defect:** any non-empty value in a caller-influenceable env var grants "trusted subagent" and fully disables Iron Law 3 enforcement. Mitigated today only by the fact that Bash-tool exports don't persist into hook processes.
- **Fix:** validate the value against the four known lite agents: `planner|software-engineer|qa-engineer|code-reviewer`. Unknown/empty value → fall through to `is_protected_path` as an orchestrator write. Document the residual accepted risk in the header comment.
- **Tests (AC):** `CLAUDE_SUBAGENT_TYPE=bogus` + tracked-file write → **blocked (exit 2)**; `CLAUDE_SUBAGENT_TYPE=software-engineer` → allowed. Existing JSON-field trust path unchanged.

### 4. G1 — No drift guard between `settings.json` and `hooks/hooks.json` — **Medium**
- **Defect:** the two files are hand-synced duplicates (README says "kept in sync"); nothing enforces it. Fixes #1 must land in both — without a guard they will diverge eventually.
- **Fix:** bats test asserting the `hooks` blocks of the two files are identical (e.g. `jq -S .hooks` both, diff). This also locks in fix #1 permanently.

### 5. D1 — README/PLAN overclaim what `setup.sh` does — **Medium (user-facing)**
- **Where:** `README.md` §Install ("installs missing tools…") and `PLAN.md` §7 (same wording).
- **Defect:** `setup.sh` only **checks** tools (WARN on missing) — installation lives solely in `scripts/install-tools.sh`. A macOS user following the README expects installs to have happened.
- **Fix:** reword to "(checks for required tools, chmods hooks, validates settings.json)"; for macOS point at `scripts/install-tools.sh` or `brew install jq gh bats-core`. Keep README and PLAN.md §7 consistent. Do NOT change the install method itself — bootstrap stays.

### 6. G3 — `.claude/scheduled_tasks.lock` not covered by `.gitignore` — **Low**
- **Fix:** add `/.claude/*.lock` (or the exact filename) to `.gitignore` so a session-id+pid lock file can't be committed by accident.

### 7. G2 + G4 — Known limitations to note / remaining planned work — **Low**
- **G2:** `state-checkpoint.sh` self-locates the "most-recently-active non-done run"; with two concurrent runs a Stop from run A can stamp run B. Add a one-line "single active run assumed" note in the hook header (or stamp by matching the session's worktree if recoverable).
- **G4 (L7):** the acknowledged open gap — no end-to-end `/lite:build` validation. Add at least a smoke-level E2E dry-run to close L7 alongside this PR, or explicitly re-scope L7 in `TASKS.md`.

---

## Definition of done

- [ ] Fixes 1–4 implemented with the listed ACs as failing-then-passing bats tests (Iron Law 1/8 discipline as per existing suite style).
- [ ] Full `bats tests/shell/` green (currently 43/43 — no regressions).
- [ ] Fixes 5–6 landed (doc wording + gitignore).
- [ ] Item 7 noted (comment/TASKS.md), L7 closed or re-scoped.
- [ ] One PR, opened not merged, body citing this file per finding ID (S1/S2/S3/G1/D1/G3/G2/G4).

## Explicitly out of scope

- Migrating distribution to the plugin marketplace (owner decision: bootstrap stays).
- Porting S2's worktree-target validation back to the heavy harness (separate repo/PR if wanted).
- Anything beyond the findings above — this is intended to be the last PR for this audit.
