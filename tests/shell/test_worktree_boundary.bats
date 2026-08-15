#!/usr/bin/env bats
# worktree-boundary.sh — a run may write only inside its own worktree.
#
# Two tests per the fail-closed discipline:
#   (a) revert-goes-RED: a write outside the worktree is BLOCKED (status 2).
#       Turning the final `block` into `exit 0` makes this fail, which proves the
#       assertion exercises the guard rather than passing vacuously.
#   (b) unevaluable-input-refuses: a write whose target cannot be read is BLOCKED,
#       never allowed through on the assumption it was probably fine.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/worktree-boundary.sh"
  LITE_TEST_HOME="$(mktemp -d)"
  export LITE_WORKTREE="$LITE_TEST_HOME/worktrees/run-1"
  mkdir -p "$LITE_WORKTREE/src"
}

teardown() { rm -rf "$LITE_TEST_HOME"; }

_run_guard() {
  printf '{"tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

@test "a write inside the worktree is allowed" {
  run _run_guard "$LITE_WORKTREE/src/thing.ts"
  [ "$status" -eq 0 ]
}

@test "a new file inside the worktree is allowed" {
  run _run_guard "$LITE_WORKTREE/src/does/not/exist/yet.ts"
  [ "$status" -eq 0 ]
}

@test "(a) a write outside the worktree is blocked" {
  run _run_guard "$LITE_TEST_HOME/elsewhere/thing.ts"
  [ "$status" -eq 2 ]
}

@test "(a) a write to an absolute system path is blocked" {
  run _run_guard "/tmp/thing.ts"
  [ "$status" -eq 2 ]
}

@test "(a) escaping the worktree with .. is blocked" {
  run _run_guard "$LITE_WORKTREE/../../etc/passwd"
  [ "$status" -eq 2 ]
}

@test "(a) a sibling directory sharing the worktree's name prefix is blocked" {
  run _run_guard "${LITE_WORKTREE}-other/thing.ts"
  [ "$status" -eq 2 ]
}

@test "(b) a write with no file_path refuses (fail-closed)" {
  run bash -c 'printf "{\"tool_input\":{}}" | bash "$0"' "$HOOK"
  [ "$status" -eq 2 ]
}

@test "(b) unreadable input refuses (fail-closed)" {
  run bash -c 'printf "not json at all" | bash "$0"' "$HOOK"
  [ "$status" -eq 2 ]
}

@test "no active run → the guard is dormant" {
  unset LITE_WORKTREE
  run _run_guard "/tmp/anywhere.ts"
  [ "$status" -eq 0 ]
}

@test "LITE_GUARDS=off → allowed even with an active run" {
  LITE_GUARDS=off run _run_guard "/tmp/anywhere.ts"
  [ "$status" -eq 0 ]
}
