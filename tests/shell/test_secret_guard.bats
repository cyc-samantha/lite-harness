#!/usr/bin/env bats
# secret-guard.sh — high-confidence credential shapes never reach the repository.
#
# The false-positive tests matter as much as the blocking ones. A guard that fires
# on anything resembling a password gets switched off, and a switched-off guard
# catches nothing.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/secret-guard.sh"
  LITE_TEST_HOME="$(mktemp -d)"
  export LITE_WORKTREE="$LITE_TEST_HOME/worktrees/run-1"
  mkdir -p "$LITE_WORKTREE"
}

teardown() { rm -rf "$LITE_TEST_HOME"; }

_write() {
  printf '{"tool_input":{"content":%s}}' "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

_edit() {
  printf '{"tool_input":{"new_string":%s}}' "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

@test "(a) a private key block is blocked" {
  run _write '-----BEGIN RSA PRIVATE KEY-----
MIIEow==
-----END RSA PRIVATE KEY-----'
  [ "$status" -eq 2 ]
}

@test "(a) a GitHub token is blocked" {
  run _write 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz'
  [ "$status" -eq 2 ]
}

@test "(a) an AWS access key id is blocked" {
  run _write 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE'
  [ "$status" -eq 2 ]
}

@test "(a) a Slack token is blocked" {
  run _write 'SLACK=xoxb-1234567890-abcdefghij'
  [ "$status" -eq 2 ]
}

@test "(a) an edit introducing a key is blocked, not only a write" {
  run _edit 'const key = "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz";'
  [ "$status" -eq 2 ]
}

@test "ordinary source is allowed" {
  run _write 'export function greet(name: string) { return `hi ${name}`; }'
  [ "$status" -eq 0 ]
}

@test "the word password in prose is allowed" {
  run _write '// Reset the password by emailing support; never store one here.'
  [ "$status" -eq 0 ]
}

@test "an environment variable reference is allowed" {
  run _write 'const token = process.env.GITHUB_TOKEN;'
  [ "$status" -eq 0 ]
}

@test "no active run → the guard is dormant" {
  unset LITE_WORKTREE
  run _write 'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz'
  [ "$status" -eq 0 ]
}
