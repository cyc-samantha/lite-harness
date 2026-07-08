#!/usr/bin/env bash
# main-branch-guard.sh — PreToolUse Bash hook (lite). Enforces Iron Law 4:
# REPO_ROOT HEAD stays on `main`; all HEAD-mutating git commands run via
# worktree delegation. Trimmed port of the heavy harness main-branch-guard.
#
# Blocks bare HEAD-mutating commands: git checkout / switch / reset --hard /
# merge / rebase, and gh pr create. A command is ALLOWED only when it carries
# a recognized delegation prefix that targets a worktree rather than the main
# checkout: `git -C <path> ...`, `git --git-dir=<path> ...`, or a leading
# `cd <path> && ...`.
#
# Iron Law 8 (fail-closed): a forbidden command whose delegation target cannot
# be evaluated (empty `cd` target) is BLOCKED, never silently allowed. Reverting
# the final `exit 2` makes the block tests go RED.
#
# Reads Claude Code PreToolUse JSON from stdin: {tool_name, tool_input.command}.

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# Non-Bash tools and empty commands are genuine no-ops — nothing to gate.
[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

is_forbidden_command() {
  local cmd="$1"
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git[[:space:]]+(checkout|switch|merge|rebase)([[:space:]]|$) ]] && return 0
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git[[:space:]]+reset[[:space:]] ]] && [[ "$cmd" =~ --hard ]] && return 0
  [[ "$cmd" =~ (^|[^[:alnum:]_-])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]] && return 0
  return 1
}

# The path token after a leading `cd `, dequoted. Empty when absent/malformed.
cd_delegation_target() {
  local cmd="$1" quoted unquoted
  quoted="$(printf '%s' "$cmd" | sed -E "s#^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+['\"]([^'\"]*)['\"].*#\1#")"
  [[ "$quoted" != "$cmd" ]] && { printf '%s' "$quoted"; return; }
  unquoted="$(printf '%s' "$cmd" | sed -E 's#^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+([^[:space:];&]*).*#\1#')"
  [[ "$unquoted" != "$cmd" ]] && printf '%s' "$unquoted"
}

has_valid_delegation() {
  local cmd="$1"
  [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+[^[:space:]] ]] && return 0
  [[ "$cmd" =~ git[[:space:]]+--git-dir=[^[:space:]] ]] && return 0
  if [[ "$cmd" =~ ^[[:space:]]*\(?[[:space:]]*cd[[:space:]] ]]; then
    # Fail-closed: an empty cd target is not evaluable delegation → not valid.
    [[ -n "$(cd_delegation_target "$cmd")" ]] && return 0
  fi
  return 1
}

is_forbidden_command "$COMMAND" || exit 0
has_valid_delegation "$COMMAND" && exit 0

printf 'BLOCKED: REPO_ROOT HEAD must stay on `main` (Iron Law 4).\n' >&2
printf 'The command:\n  %s\n' "$COMMAND" >&2
printf 'is HEAD-mutating without valid worktree delegation.\n' >&2
printf 'Delegate via: `cd "$WORKTREE" && ...`, `git -C "$WORKTREE" ...`, or `git --git-dir=...`.\n' >&2
exit 2
