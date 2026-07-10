#!/usr/bin/env bats
# G4 — smoke-level E2E dry-run of /lite:build's hook wiring (skills/build/SKILL.md
# Steps 2-8), without spawning real agents (no live Claude Code session available
# to bats). This exercises the actual chain a real run depends on:
#   1. STATE.md is writable by the orchestrator at its allowlisted path (Step 2).
#   2. The worktree is created at the pinned `.claude/worktrees/<slug>` convention
#      (Step 2) — the same path main-branch-guard's delegation check (S2) and
#      orchestrator-guard's allowlist both key off of.
#   3. main-branch-guard allows delegated commands scoped to that worktree,
#      including the exact `cd "<worktree>" && gh pr create ...` form Step 7
#      requires, and still blocks the same command run bare.
#   4. state-checkpoint.sh self-locates and stamps the run's STATE.md on Stop,
#      matching the resume contract in PLAN.md §5.
# A regression in any of these breaks a real /lite:build run even though each
# hook's own unit tests stay green in isolation — this is the wiring check.

setup() {
  HOOKS_DIR="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)"
  TMP_REPO="$(mktemp -d)"
  git -C "$TMP_REPO" init -q -b main
  git -C "$TMP_REPO" config user.email t@t
  git -C "$TMP_REPO" config user.name t
  printf '# repo\n' > "$TMP_REPO/README.md"
  git -C "$TMP_REPO" add README.md
  git -C "$TMP_REPO" commit -qm init

  SLUG="smoke-e2e-2026-07-10"
  export CLAUDE_PLUGIN_DATA="$(mktemp -d)"
  STATE_DIR="$CLAUDE_PLUGIN_DATA/lite/runs/$SLUG"
  STATE_FILE="$STATE_DIR/STATE.md"
  WORKTREE="$TMP_REPO/.claude/worktrees/$SLUG"
}

teardown() { rm -rf "$TMP_REPO" "$CLAUDE_PLUGIN_DATA"; }

_write_state() {
  # $1 = phase
  mkdir -p "$STATE_DIR"
  printf -- '---\nidea: "smoke test idea"\nrepo: %s\nbranch: lite/%s\nworktree: %s\ncreated: 2026-07-10T00:00:00Z\nphase: %s\nreview_loops: 0\n---\n## Phases\n- [ ] Plan\n' \
    "$TMP_REPO" "$SLUG" "$WORKTREE" "$1" > "$STATE_FILE"
}

_orchestrator_guard() {
  printf '{"tool_input":{"file_path":%s},"subagent_type":%s}' \
    "$(printf '%s' "$1" | jq -Rs .)" "$(printf '%s' "${2:-}" | jq -Rs .)" \
    | bash "$HOOKS_DIR/orchestrator-guard.sh"
}

_main_branch_guard() {
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
    "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOKS_DIR/main-branch-guard.sh"
}

@test "Step 2: orchestrator can write STATE.md at the allowlisted runs/<slug>/ path" {
  _write_state "plan"
  run _orchestrator_guard "$STATE_FILE" ""
  [ "$status" -eq 0 ]
}

@test "Step 2: git worktree add at the pinned .claude/worktrees/<slug> convention succeeds" {
  git -C "$TMP_REPO" branch "lite/$SLUG" main
  run git -C "$TMP_REPO" worktree add "$WORKTREE" "lite/$SLUG"
  [ "$status" -eq 0 ]
  [ -d "$WORKTREE" ]
}

@test "Step 4-6: main-branch-guard allows worktree-delegated commits during build" {
  git -C "$TMP_REPO" branch "lite/$SLUG" main
  git -C "$TMP_REPO" worktree add "$WORKTREE" "lite/$SLUG" >/dev/null
  _write_state "build"
  run _main_branch_guard "cd \"$WORKTREE\" && git merge --no-ff other-branch"
  [ "$status" -eq 0 ]
}

@test "Step 7: the exact delegated gh pr create form from SKILL.md is allowed" {
  git -C "$TMP_REPO" branch "lite/$SLUG" main
  git -C "$TMP_REPO" worktree add "$WORKTREE" "lite/$SLUG" >/dev/null
  _write_state "pr"
  run _main_branch_guard "cd \"$WORKTREE\" && gh pr create --base main --head lite/$SLUG --title x --body y"
  [ "$status" -eq 0 ]
}

@test "Step 7: the same gh pr create run bare (no delegation) is still blocked" {
  git -C "$TMP_REPO" branch "lite/$SLUG" main
  git -C "$TMP_REPO" worktree add "$WORKTREE" "lite/$SLUG" >/dev/null
  _write_state "pr"
  run _main_branch_guard "gh pr create --base main --head lite/$SLUG --title x --body y"
  [ "$status" -eq 2 ]
}

@test "Step 8: state-checkpoint.sh self-locates and stamps the run on Stop" {
  _write_state "review"
  run bash "$HOOKS_DIR/state-checkpoint.sh"
  [ "$status" -eq 0 ]
  grep -q '^last_seen:' "$STATE_FILE"
  grep -q '^phase: review$' "$STATE_FILE"
}
