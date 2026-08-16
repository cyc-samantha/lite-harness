#!/usr/bin/env bats
# bash-boundary.sh — Iron Law 8 fail-closed tests.
#
# Per the repository rule each gate ships two:
#   (a) revert-goes-RED: a write outside the worktree is BLOCKED (status 2).
#       Reverting `exit 2` in `block` makes every assertion in that group fail.
#   (b) unevaluable-input-refuses: a target this guard cannot resolve — a
#       variable, a substitution, a `cd` it could not follow, an unreadable
#       payload — is BLOCKED, never allowed through on the assumption it was
#       probably fine.
#
# The allow group matters as much as the block group. A guard that refuses
# ordinary work gets switched off, and a switched-off guard catches nothing.

setup() {
  HOOK="$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)/bash-boundary.sh"
  LITE_TEST_HOME="$(mktemp -d)"
  export LITE_WORKTREE="$LITE_TEST_HOME/worktrees/run-1"
  mkdir -p "$LITE_WORKTREE"
}

teardown() { rm -rf "$LITE_TEST_HOME"; }

_run_guard() {
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
    "$(printf '%s' "$1" | jq -Rs .)" | bash "$HOOK"
}

@test "(a) an absolute write outside the worktree is blocked" {
  run _run_guard 'rm -rf /etc/nginx'
  [ "$status" -eq 2 ]
}

@test "(a) a redirect into a home directory is blocked" {
  run _run_guard 'echo evil >> /home/someone/.bashrc'
  [ "$status" -eq 2 ]
}

@test "(a) sed -i on a path outside the worktree is blocked" {
  run _run_guard 'sed -i s/a/b/ /etc/hosts'
  [ "$status" -eq 2 ]
}

@test "(a) a tilde target is blocked, not read as a relative path" {
  run _run_guard 'echo evil > ~/.bashrc'
  [ "$status" -eq 2 ]
}

@test "(a) an escaping relative path is blocked" {
  run _run_guard 'rm -rf ../other-repo'
  [ "$status" -eq 2 ]
}

@test "(a) copying OUT of the worktree to an outside path is blocked" {
  run _run_guard 'cp src/secrets.ts /tmp/exfil.ts'
  [ "$status" -eq 2 ]
}

@test "(a) mv treats its source as a write, because it removes it" {
  run _run_guard "mv /etc/hosts $LITE_WORKTREE/hosts"
  [ "$status" -eq 2 ]
}

@test "(a) privilege escalation is refused before any target is examined" {
  run _run_guard 'sudo apt-get install -y curl'
  [ "$status" -eq 2 ]
}

@test "(a) a write riding on a later clause is still blocked" {
  run _run_guard 'npm test && rm -rf /var/lib/thing'
  [ "$status" -eq 2 ]
}

@test "(b) a target built from a variable refuses" {
  run _run_guard 'rm -rf $BUILD_DIR/'
  [ "$status" -eq 2 ]
}

@test "(b) a target built from a substitution refuses" {
  run _run_guard 'rm -rf $(cat /tmp/where)'
  [ "$status" -eq 2 ]
}

@test "(b) an unset variable that would expand to the root refuses" {
  run _run_guard 'rm -rf "$UNSET_ANYWHERE"/'
  [ "$status" -eq 2 ]
}

@test "(b) a relative write after a cd out of the worktree refuses" {
  run _run_guard 'cd /etc && rm -rf conf.d'
  [ "$status" -eq 2 ]
}

@test "(b) a relative write after an unresolvable cd refuses" {
  run _run_guard 'cd "$SOMEWHERE" && rm -rf build'
  [ "$status" -eq 2 ]
}

@test "(b) an unreadable payload refuses" {
  run bash -c "printf 'not json' | bash '$HOOK'"
  [ "$status" -eq 2 ]
}

@test "a relative write inside the worktree is allowed" {
  run _run_guard 'rm -rf node_modules'
  [ "$status" -eq 0 ]
}

@test "an absolute write under the worktree is allowed" {
  run _run_guard "rm -rf $LITE_WORKTREE/build"
  [ "$status" -eq 0 ]
}

@test "an ordinary gate command is allowed" {
  run _run_guard 'npx vitest run --reporter=dot'
  [ "$status" -eq 0 ]
}

@test "a redirect to /dev/null is allowed" {
  run _run_guard 'npm test > /dev/null 2>&1'
  [ "$status" -eq 0 ]
}

@test "reading a file outside the worktree is allowed" {
  run _run_guard 'cat /etc/os-release'
  [ "$status" -eq 0 ]
}

@test "copying a template INTO the worktree is allowed" {
  run _run_guard 'cp /usr/share/tpl.json ./config.json'
  [ "$status" -eq 0 ]
}

@test "a relative write after a cd back inside the worktree is allowed" {
  run _run_guard "cd $LITE_WORKTREE && rm -rf build"
  [ "$status" -eq 0 ]
}

@test "a non-Bash tool is not this hook's business" {
  run bash -c "printf '{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/etc/hosts\"}}' | bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "no active run → the guard is dormant" {
  unset LITE_WORKTREE
  run _run_guard 'rm -rf /etc/nginx'
  [ "$status" -eq 0 ]
}

@test "LITE_GUARDS=off → allowed even with an active run" {
  export LITE_GUARDS=off
  run _run_guard 'rm -rf /etc/nginx'
  [ "$status" -eq 0 ]
}
