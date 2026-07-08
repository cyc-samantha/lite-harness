#!/usr/bin/env bats
# orchestrator-guard.sh (lite) — Iron Law 3 + Iron Law 8 fail-closed tests.
#
# Per Iron Law 8 each gate ships two tests:
#   (a) revert-goes-RED: the orchestrator (no subagent_type) writing a git-tracked
#       file is BLOCKED (status 2). Reverting the hook's final `exit 2` to `exit 0`
#       makes this fail — proving the test exercises the guard.
#   (b) unevaluable-input-refuses: an orchestrator write with an empty file_path
#       (unevaluable target) is BLOCKED, not silently allowed.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/orchestrator-guard.sh"
  TMP_REPO="$(mktemp -d)"
  git -C "$TMP_REPO" init -q
  git -C "$TMP_REPO" config user.email t@t
  git -C "$TMP_REPO" config user.name t
  printf 'tracked\n' > "$TMP_REPO/tracked.md"
  mkdir -p "$TMP_REPO/src"
  printf 'code\n' > "$TMP_REPO/src/app.js"
  git -C "$TMP_REPO" add tracked.md src/app.js
  git -C "$TMP_REPO" commit -qm init
}

teardown() { rm -rf "$TMP_REPO"; }

_run_guard() {
  # $1 = file_path, $2 = subagent_type (optional)
  printf '{"tool_input":{"file_path":%s},"subagent_type":%s}' \
    "$(printf '%s' "$1" | jq -Rs .)" "$(printf '%s' "${2:-}" | jq -Rs .)" \
    | bash "$HOOK"
}

@test "(a) orchestrator writing a tracked file is blocked" {
  run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 2 ]
}

@test "(a) orchestrator net-new file in a tracked dir is blocked" {
  run _run_guard "$TMP_REPO/src/new-module.js" ""
  [ "$status" -eq 2 ]
}

@test "subagent writing a tracked file is allowed" {
  run _run_guard "$TMP_REPO/tracked.md" "software-engineer"
  [ "$status" -eq 0 ]
}

@test "allowlisted STATE.md under runs/ is allowed" {
  run _run_guard "/data/runs/my-run/STATE.md" ""
  [ "$status" -eq 0 ]
}

@test "allowlisted .token file is allowed" {
  run _run_guard "$TMP_REPO/approval.token" ""
  [ "$status" -eq 0 ]
}

@test "genuine scratch file outside any repo is allowed" {
  local scratch; scratch="$(mktemp -d)"
  run _run_guard "$scratch/notes.txt" ""
  [ "$status" -eq 0 ]
  rm -rf "$scratch"
}

@test "(b) orchestrator write with empty file_path refuses (fail-closed)" {
  run _run_guard "" ""
  [ "$status" -eq 2 ]
}
