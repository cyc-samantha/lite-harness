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
  mkdir -p "$TMP_REPO/docs/runs"
  printf 'not a run state file\n' > "$TMP_REPO/docs/runs/setup.md"
  git -C "$TMP_REPO" add tracked.md src/app.js docs/runs/setup.md
  git -C "$TMP_REPO" commit -qm init
  # F6: the guard only enforces while a lite run is active. Give every test an
  # active (non-done) run so the Iron Law 3 block/allow assertions exercise the
  # guard body; the no-active-run and LITE_GUARDS=off cases override this.
  export CLAUDE_PLUGIN_DATA="$(mktemp -d)"
  mkdir -p "$CLAUDE_PLUGIN_DATA/lite/runs/active"
  printf -- '---\nphase: build\ncreated: 2026-07-09T08:00:00Z\n---\n' \
    > "$CLAUDE_PLUGIN_DATA/lite/runs/active/STATE.md"
}

teardown() { rm -rf "$TMP_REPO" "$CLAUDE_PLUGIN_DATA"; }

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

@test "SEC-MED-2 fallback: subagent write with no JSON subagent_type field but CLAUDE_SUBAGENT_TYPE env var set is allowed" {
  CLAUDE_SUBAGENT_TYPE="software-engineer" run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 0 ]
}

@test "tracked docs/runs/ path is NOT allowlisted by the anchored runs pattern (over-match regression guard)" {
  run _run_guard "$TMP_REPO/docs/runs/setup.md" ""
  [ "$status" -eq 2 ]
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

# --- S3: CLAUDE_SUBAGENT_TYPE env fallback must be a known lite agent -------

@test "S3: unknown CLAUDE_SUBAGENT_TYPE does not bypass the guard on a tracked file" {
  CLAUDE_SUBAGENT_TYPE="bogus" run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 2 ]
}

@test "S3: known CLAUDE_SUBAGENT_TYPE (software-engineer) via env fallback is allowed" {
  CLAUDE_SUBAGENT_TYPE="software-engineer" run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 0 ]
}

# --- F6: run-scoped enforcement ----------------------------------------------

@test "no active run → orchestrator write to a tracked file is allowed (guard is dormant)" {
  rm -rf "$CLAUDE_PLUGIN_DATA/lite/runs"
  run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 0 ]
}

@test "LITE_GUARDS=off → orchestrator write to a tracked file is allowed even with an active run" {
  LITE_GUARDS=off run _run_guard "$TMP_REPO/tracked.md" ""
  [ "$status" -eq 0 ]
}
