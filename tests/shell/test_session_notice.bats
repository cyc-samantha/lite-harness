#!/usr/bin/env bats
# session-notice.sh (lite) — SessionStart print-only resume notice.
#
# This is advisory UX, not a security/correctness gate (PLAN.md §5): it never
# writes, blocks, or gates anything — it just prints a reminder. A single
# smoke test covering the "prints" and "no-ops" paths is sufficient per the
# software-engineer task note, rather than the full Iron Law 8 two-test
# treatment reserved for gates that admit/stop work.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/session-notice.sh"
  export CLAUDE_PLUGIN_DATA="$(mktemp -d)"
}

teardown() { rm -rf "$CLAUDE_PLUGIN_DATA"; }

@test "prints notice when a non-done run exists" {
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/photo-dedupe-2026-07-09"
  printf -- '---\nidea: "dedupe photos"\nphase: build\nlast_seen: 2026-07-09T10:00:00Z\n---\n' \
    > "$CLAUDE_PLUGIN_DATA/runs/photo-dedupe-2026-07-09/STATE.md"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  [[ "$output" == "Lite run 'photo-dedupe-2026-07-09' is in build — run /lite:resume to continue." ]]
}

@test "picks the most recently active non-done run" {
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/older-run" "$CLAUDE_PLUGIN_DATA/runs/newer-run"
  printf -- '---\nphase: review\nlast_seen: 2026-07-01T00:00:00Z\n---\n' \
    > "$CLAUDE_PLUGIN_DATA/runs/older-run/STATE.md"
  printf -- '---\nphase: test\nlast_seen: 2026-07-09T09:00:00Z\n---\n' \
    > "$CLAUDE_PLUGIN_DATA/runs/newer-run/STATE.md"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  [[ "$output" == "Lite run 'newer-run' is in test — run /lite:resume to continue." ]]
}

@test "no-ops silently when all runs are done" {
  mkdir -p "$CLAUDE_PLUGIN_DATA/runs/finished-run"
  printf -- '---\nphase: done\nlast_seen: 2026-07-09T09:00:00Z\n---\n' \
    > "$CLAUDE_PLUGIN_DATA/runs/finished-run/STATE.md"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no-ops silently when no runs directory exists" {
  rm -rf "$CLAUDE_PLUGIN_DATA"
  export CLAUDE_PLUGIN_DATA="$(mktemp -d)/does-not-exist"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no-ops silently when CLAUDE_PLUGIN_DATA is unset" {
  unset CLAUDE_PLUGIN_DATA
  run bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
