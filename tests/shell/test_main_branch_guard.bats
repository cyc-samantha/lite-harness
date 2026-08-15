#!/usr/bin/env bats
# main-branch-guard.sh (lite) — Iron Law 4 + Iron Law 8 fail-closed tests.
#
# Per Iron Law 8 each gate ships two tests:
#   (a) revert-goes-RED: a bare forbidden command is BLOCKED (status 2). Reverting
#       the hook's final `exit 2` to `exit 0` makes this assertion fail — proving
#       the test exercises the guard, not a tautology.
#   (b) unevaluable-input-refuses: a forbidden command with an EMPTY `cd`
#       delegation target (unevaluable delegation) is still BLOCKED, not allowed.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/main-branch-guard.sh"
  # The guard only enforces while a run is in flight, which the engine signals by
  # exporting the run's worktree. Give every test one so the block/allow
  # assertions exercise the guard body; the no-run and LITE_GUARDS=off cases
  # override this.
  LITE_TEST_HOME="$(mktemp -d)"
  export LITE_WORKTREE="$LITE_TEST_HOME/worktrees/run-1"
  mkdir -p "$LITE_WORKTREE"
}

teardown() { rm -rf "$LITE_TEST_HOME"; }

_run_guard() {
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
    "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

@test "(a) bare git checkout is blocked" {
  run _run_guard 'git checkout some-branch'
  [ "$status" -eq 2 ]
}

@test "(a) bare git reset --hard is blocked" {
  run _run_guard 'git reset --hard HEAD~1'
  [ "$status" -eq 2 ]
}

@test "(a) bare gh pr create is blocked" {
  run _run_guard 'gh pr create --fill'
  [ "$status" -eq 2 ]
}

@test "valid git -C delegation is allowed" {
  run _run_guard 'git -C /path/to/.claude/worktrees/wt checkout some-branch'
  [ "$status" -eq 0 ]
}

@test "valid cd delegation is allowed" {
  run _run_guard 'cd "$WORKTREE" && git merge feature'
  [ "$status" -eq 0 ]
}

@test "non-mutating git command is allowed" {
  run _run_guard 'git status'
  [ "$status" -eq 0 ]
}

@test "(b) forbidden command with empty cd target refuses (fail-closed)" {
  run _run_guard "cd '' && git checkout main"
  [ "$status" -eq 2 ]
}

@test "(b) empty command no-ops safely" {
  run bash -c 'printf "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"\"}}" | bash "$1"' _ "$HOOK"
  [ "$status" -eq 0 ]
}

# --- S2: delegation target must be a pinned .claude/worktrees/<slug> path ----

@test "S2: git -C . checkout is blocked (REPO_ROOT masquerading as delegation)" {
  run _run_guard 'git -C . checkout main'
  [ "$status" -eq 2 ]
}

@test "S2: cd <repo-root> && git checkout is blocked (non-worktree cd target)" {
  run _run_guard 'cd /home/user/myrepo && git checkout main'
  [ "$status" -eq 2 ]
}

@test "S2: git --work-tree=/x checkout is blocked (intervening global flag hides forbidden command no more)" {
  run _run_guard 'git --work-tree=/x checkout main'
  [ "$status" -eq 2 ]
}

@test "S2: git -C <worktree> checkout remains allowed" {
  run _run_guard 'git -C /path/to/.claude/worktrees/wt checkout some-branch'
  [ "$status" -eq 0 ]
}

@test "S2: cd \"\$WORKTREE\" && git merge remains allowed" {
  run _run_guard 'cd "$WORKTREE" && git merge feature'
  [ "$status" -eq 0 ]
}

# --- Fix-cycle: narrow $WORKTREE-only variable allowance, per-clause scoping -

@test "exploit: cd \$PWD && git checkout main is blocked (bare var allowance too broad)" {
  run _run_guard 'cd "$PWD" && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: cd \$HOME && git checkout main is blocked (bare var allowance too broad)" {
  run _run_guard 'cd "$HOME" && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: git -C \$PWD checkout main is blocked (bare var allowance too broad)" {
  run _run_guard 'git -C "$PWD" checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: cd \$OLDPWD && git reset --hard is blocked (bare var allowance too broad)" {
  run _run_guard 'cd "$OLDPWD" && git reset --hard HEAD~1'
  [ "$status" -eq 2 ]
}

@test "exploit: git checkout main && git -C <worktree> status is blocked (delegation not scoped to forbidden clause)" {
  run _run_guard 'git checkout main && git -C /x/.claude/worktrees/y status'
  [ "$status" -eq 2 ]
}

@test "exploit: git checkout main; echo -C <worktree> is blocked (non-git -C token laundering)" {
  run _run_guard 'git checkout main; echo -C /any/.claude/worktrees/z'
  [ "$status" -eq 2 ]
}

@test "regression: git --git-dir=\"\$WORKTREE/.git\" checkout remains allowed (variable-plus-subpath)" {
  run _run_guard 'git --git-dir="$WORKTREE/.git" checkout main'
  [ "$status" -eq 0 ]
}

@test "low-priority: path-traversal escape out of pinned worktree dir is blocked" {
  run _run_guard 'cd "/x/.claude/worktrees/../../etc" && git checkout main'
  [ "$status" -eq 2 ]
}

# --- F6: run-scoped enforcement ----------------------------------------------

# --- Fix-cycle round 3: leading-cd ambient state must be re-checked on later cds -

@test "exploit: cd \"\$WORKTREE\"; cd /repo && git checkout main is blocked (later cd resets ambient delegation)" {
  run _run_guard 'cd "$WORKTREE"; cd /repo && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: cd \"\$WORKTREE\" && cd /repo && git checkout main is blocked (later cd resets ambient delegation)" {
  run _run_guard 'cd "$WORKTREE" && cd /repo && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: cd .claude/worktrees/x; cd /home/x && git reset --hard is blocked (later cd resets ambient delegation)" {
  run _run_guard 'cd .claude/worktrees/x; cd /home/x && git reset --hard HEAD~1'
  [ "$status" -eq 2 ]
}

@test "regression: cd \"\$WORKTREE\" && git status && git checkout feature remains allowed (ambient persists across non-cd clause)" {
  run _run_guard 'cd "$WORKTREE" && git status && git checkout feature'
  [ "$status" -eq 0 ]
}

@test "no active run → forbidden command is allowed (guard is dormant)" {
  unset LITE_WORKTREE
  run _run_guard 'git checkout some-branch'
  [ "$status" -eq 0 ]
}

@test "LITE_GUARDS=off → forbidden command is allowed even with an active run" {
  LITE_GUARDS=off run _run_guard 'git checkout some-branch'
  [ "$status" -eq 0 ]
}

# --- Fix-cycle round 4: subshell-scoped cd must not leak ambient_ok outward -

@test "exploit: ( cd \"\$WORKTREE\" ) && git checkout main is blocked (subshell cd doesn't persist to parent shell)" {
  run _run_guard '( cd "$WORKTREE" ) && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: ( cd \"\$WORKTREE\" && git status ) && git checkout main is blocked (subshell cd doesn't persist to parent shell)" {
  run _run_guard '( cd "$WORKTREE" && git status ) && git checkout main'
  [ "$status" -eq 2 ]
}

@test "exploit: ( cd \"\$WORKTREE\" ) && git switch main is blocked (subshell cd doesn't persist to parent shell)" {
  run _run_guard '( cd "$WORKTREE" ) && git switch main'
  [ "$status" -eq 2 ]
}

@test "exploit: ( cd \"\$WORKTREE\" && echo hi ); git checkout main is blocked (subshell cd doesn't persist to parent shell)" {
  run _run_guard '( cd "$WORKTREE" && echo hi ); git checkout main'
  [ "$status" -eq 2 ]
}

@test "regression: ( cd \"\$WORKTREE\" && git checkout main ) remains allowed (forbidden command inside same subshell as its own cd)" {
  run _run_guard '( cd "$WORKTREE" && git checkout main )'
  [ "$status" -eq 0 ]
}

@test "regression: cd \"\$WORKTREE\" && git checkout main (plain persistent cd, no subshell) remains allowed" {
  run _run_guard 'cd "$WORKTREE" && git checkout main'
  [ "$status" -eq 0 ]
}

@test "regression: git -C \"\$WORKTREE\" checkout main remains allowed (per-clause delegation, unaffected)" {
  run _run_guard 'git -C "$WORKTREE" checkout main'
  [ "$status" -eq 0 ]
}
