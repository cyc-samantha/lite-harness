#!/usr/bin/env bats
# code-shape-check.sh (lite) — ADVISORY shape linter + Iron Law 8 degrade-safe.
#
# This gate is advisory: it NEVER blocks (always exit 0). Its Law-8 posture is
# degrade-safe. Per Iron Law 8 each gate ships two tests:
#   (a) revert-goes-RED: a too-long / too-wide function WARNS on stderr yet the
#       status is 0 (advisory contract). Reverting the always-exit-0 contract
#       (e.g. `exit 2` on a violation) turns the "status is 0" assertion RED —
#       proving the test exercises the advisory guard.
#   (b) unevaluable-input-refuses: unevaluable input (empty path, missing file,
#       unknown language) degrades to a clean exit 0 with no warning.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/code-shape-check.sh"
  WORK="$(mktemp -d)"
}

teardown() { rm -rf "$WORK"; }

_run_hook() {
  printf '{"tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

@test "(a) too-long JS function warns but returns exit 0" {
  {
    printf 'function big() {\n'
    for i in $(seq 1 20); do printf '  const v%d = %d;\n' "$i" "$i"; done
    printf '}\n'
  } > "$WORK/big.js"
  run _run_hook "$WORK/big.js"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'CODE-SHAPE (advisory)'
}

@test "(a) too-many-params Python signature warns but returns exit 0" {
  printf 'def wide(a, b, c, d, e, f):\n    return a\n' > "$WORK/wide.py"
  run _run_hook "$WORK/wide.py"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'params'
}

@test "small compliant JS function produces no warning" {
  printf 'function ok(a, b) {\n  return a + b;\n}\n' > "$WORK/ok.js"
  run _run_hook "$WORK/ok.js"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "(b) missing file degrades to clean exit 0 with no warning" {
  run _run_hook "$WORK/does-not-exist.ts"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "(b) empty file_path degrades to clean exit 0" {
  run _run_hook ""
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "(b) unknown language degrades to clean exit 0" {
  printf 'some text\n' > "$WORK/notes.txt"
  run _run_hook "$WORK/notes.txt"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
