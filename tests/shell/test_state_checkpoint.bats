#!/usr/bin/env bats
# state-checkpoint.sh (lite) — resume-state stamping + Iron Law 8 fail-closed.
#
# Per Iron Law 8 each gate ships two tests:
#   (a) revert-goes-RED: a file with NO YAML frontmatter is left UNCHANGED (the
#       hook no-ops rather than corrupt it). Reverting the awk-derived
#       `fence_end` frontmatter-close gate in state-checkpoint.sh makes the
#       hook stamp the file regardless, turning the "unchanged" assertion RED —
#       proving the test exercises it.
#   (b) unevaluable-input-refuses: a missing/empty path no-ops safely (status 0,
#       no file created, no crash).

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/state-checkpoint.sh"
  WORK="$(mktemp -d)"
}

teardown() { rm -rf "$WORK"; }

@test "stamps last_seen into frontmatter" {
  printf -- '---\nidea: "x"\nphase: build\n---\n## body\n' > "$WORK/STATE.md"
  run bash "$HOOK" "$WORK/STATE.md"
  [ "$status" -eq 0 ]
  grep -q '^last_seen: ' "$WORK/STATE.md"
}

@test "updates phase when LITE_PHASE is set" {
  printf -- '---\nphase: build\n---\n' > "$WORK/STATE.md"
  LITE_PHASE=review run bash "$HOOK" "$WORK/STATE.md"
  [ "$status" -eq 0 ]
  grep -q '^phase: review$' "$WORK/STATE.md"
}

@test "leaves existing phase untouched when LITE_PHASE unset" {
  printf -- '---\nphase: build\n---\n' > "$WORK/STATE.md"
  run bash "$HOOK" "$WORK/STATE.md"
  [ "$status" -eq 0 ]
  grep -q '^phase: build$' "$WORK/STATE.md"
}

@test "(a) file without frontmatter is left unchanged" {
  printf 'no frontmatter here\njust text\n' > "$WORK/plain.md"
  local before; before="$(cat "$WORK/plain.md")"
  run bash "$HOOK" "$WORK/plain.md"
  [ "$status" -eq 0 ]
  [ "$(cat "$WORK/plain.md")" = "$before" ]
  ! grep -q 'last_seen' "$WORK/plain.md"
}

@test "(b) missing file path no-ops safely without creating it" {
  run bash "$HOOK" "$WORK/does-not-exist.md"
  [ "$status" -eq 0 ]
  [ ! -e "$WORK/does-not-exist.md" ]
}

@test "(b) empty/absent argument no-ops safely" {
  run bash "$HOOK"
  [ "$status" -eq 0 ]
}

# --- self-location (F4): no argument → find the active run and stamp it -------

@test "self-locates the single non-done run when called with no argument" {
  export CLAUDE_PLUGIN_DATA="$WORK"
  mkdir -p "$WORK/lite/runs/only-run"
  printf -- '---\nphase: build\ncreated: 2026-07-09T08:00:00Z\n---\n' \
    > "$WORK/lite/runs/only-run/STATE.md"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  grep -q '^last_seen: ' "$WORK/lite/runs/only-run/STATE.md"
}

@test "self-locates the most-recently-active among multiple non-done runs" {
  export CLAUDE_PLUGIN_DATA="$WORK"
  mkdir -p "$WORK/lite/runs/older" "$WORK/lite/runs/newer"
  printf -- '---\nphase: build\nlast_seen: 2026-07-01T00:00:00Z\n---\n' \
    > "$WORK/lite/runs/older/STATE.md"
  printf -- '---\nphase: review\nlast_seen: 2026-07-09T09:00:00Z\n---\n' \
    > "$WORK/lite/runs/newer/STATE.md"

  run bash "$HOOK"
  [ "$status" -eq 0 ]
  # Newer run got a fresh stamp overwriting its old last_seen; older untouched.
  ! grep -q '^last_seen: 2026-07-09T09:00:00Z$' "$WORK/lite/runs/newer/STATE.md"
  grep -q '^last_seen: 2026-07-01T00:00:00Z$' "$WORK/lite/runs/older/STATE.md"
}

@test "no-ops safely when zero runs exist" {
  export CLAUDE_PLUGIN_DATA="$WORK"
  mkdir -p "$WORK/lite/runs"
  run bash "$HOOK"
  [ "$status" -eq 0 ]
}
