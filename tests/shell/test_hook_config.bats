#!/usr/bin/env bats
# Hook registration config invariants (lite): settings.json + hooks/hooks.json.
#
# S1: hook `timeout` is authored in SECONDS (per the published Claude Code
#     hooks schema), not milliseconds. A `5000`/`10000` literal is ~83/166
#     minutes, not 5s/10s — a wedged guard hook would stall a tool call for
#     over an hour instead of failing fast. This asserts every registered
#     timeout is a sane <=30s value in BOTH files.
# G1: the two files are hand-synced duplicates (README: "kept in sync"); this
#     locks that invariant with a drift guard so a future edit to only one of
#     them fails CI instead of silently diverging.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

@test "S1: every timeout value in settings.json is <= 30" {
  cd "$REPO"
  local over
  over="$(jq '[.. | .timeout? // empty | select(. > 30)] | length' settings.json)"
  [ "$over" -eq 0 ]
}

@test "S1: every timeout value in hooks/hooks.json is <= 30" {
  cd "$REPO"
  local over
  over="$(jq '[.. | .timeout? // empty | select(. > 30)] | length' hooks/hooks.json)"
  [ "$over" -eq 0 ]
}

@test "G1: .hooks blocks of settings.json and hooks/hooks.json are byte-identical (jq -S normalized)" {
  cd "$REPO"
  run diff <(jq -S .hooks settings.json) <(jq -S .hooks hooks/hooks.json)
  [ "$status" -eq 0 ]
}
