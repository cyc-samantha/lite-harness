#!/usr/bin/env bash
# orchestrator-guard.sh — PreToolUse Write|Edit hook (lite). Enforces Iron Law 3:
# the orchestrator never writes source. Trimmed port of the heavy harness
# is-protected-path.sh + orchestrator-discipline logic.
#
# Blocks the orchestrator (a caller with no subagent_type) from writing to any
# git-tracked path, or a net-new file inside a git-tracked directory. Worktree
# subagents (subagent_type set) are trusted and pass through.
#
# Lite allowlist (always writable, even by the orchestrator):
#   - .md files under a runs/ or pipeline-state/ state directory
#   - .token files
#   - anything under a .claude/worktrees/ path
#
# Iron Law 8 (fail-closed):
#   - orchestrator Write/Edit with an empty file_path (unevaluable target) is
#     BLOCKED, not silently allowed.
#   - is_protected_path BLOCKS on empty path and on any git error other than
#     "not a git repository" (which is a genuine non-repo scratch path).
# Reverting the `exit 2` on a tracked path makes the block test go RED.
#
# Reads PreToolUse JSON from stdin: {tool_input.file_path, subagent_type}.
#
# Trusted-caller signal (SEC-MED-2 pattern, mirrored from the heavy harness's
# vlm-critic-read-guard.sh): the top-level `.subagent_type` JSON field is not
# always present on a real subagent Write/Edit event. When it's absent, this
# guard also honors the `CLAUDE_SUBAGENT_TYPE` env var the orchestrator sets
# on a subagent's spawn env — either signal being non-empty passes the caller
# through as trusted. Without this fallback, a missing JSON field would make
# a genuine software-engineer/qa-engineer write fall through to
# is_protected_path and get blocked in its own worktree (Build dies on arrival).

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
SUBAGENT_TYPE="$(printf '%s' "$INPUT" | jq -r '.subagent_type // empty' 2>/dev/null)"
[[ -z "$SUBAGENT_TYPE" ]] && SUBAGENT_TYPE="${CLAUDE_SUBAGENT_TYPE:-}"

# exit 0 = ALLOW (write here), exit 2 = BLOCK.
is_protected_path() {
  local path="${1:-}" parent repo relpath parent_rel tracked git_err rc
  [[ -z "$path" ]] && return 0                       # fail-closed: empty → BLOCK
  parent="$(dirname -- "$path" 2>/dev/null)" || return 0
  [[ -z "$parent" ]] && return 0
  repo="$(git -C "$parent" rev-parse --show-toplevel 2>/dev/null)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    git_err="$(git -C "$parent" rev-parse --show-toplevel 2>&1 1>/dev/null)"
    [[ "$git_err" == *"not a git repository"* ]] && return 1   # genuine scratch → ALLOW
    return 0                                          # other git error → BLOCK (fail-closed)
  fi
  [[ -z "$repo" ]] && return 0
  relpath="${path#"$repo"/}"
  [[ "$relpath" == /* ]] && return 0                  # path outside repo prefix → BLOCK
  git -C "$repo" ls-files --error-unmatch -- "$relpath" >/dev/null 2>&1 && return 0  # tracked → BLOCK
  parent_rel="${parent#"$repo"/}"
  [[ "$parent" == "$repo" ]] && parent_rel="."
  tracked="$(git -C "$repo" ls-files -- "$parent_rel/" 2>/dev/null | head -1)"
  [[ -n "$tracked" ]] && return 0                     # net-new in tracked dir → BLOCK
  return 1                                            # genuine scratch dir → ALLOW
}

is_allowlisted() {
  local p="$1"
  [[ "$p" =~ /\.claude/worktrees/ ]] && return 0
  [[ "$p" =~ (^|/)[^/]+\.token$ ]] && return 0
  # Anchored to the runs/<slug>/ state-dir shape (NOT a bare /runs/ substring
  # match, which would over-match e.g. docs/runs/setup.md).
  [[ "$p" =~ /runs/[^/]+/[^/]+\.md$ ]] && return 0
  [[ "$p" =~ /pipeline-state/.*\.md$ ]] && return 0
  return 1
}

# Worktree subagents are trusted callers — they own their worktree tree.
[[ -n "$SUBAGENT_TYPE" ]] && exit 0

# Fail-closed: an orchestrator write with no evaluable target refuses.
[[ -z "$FILE_PATH" ]] && {
  printf 'BLOCKED: orchestrator write with no file_path (unevaluable target, Iron Law 8).\n' >&2
  exit 2
}

is_allowlisted "$FILE_PATH" && exit 0
is_protected_path "$FILE_PATH" || exit 0

printf 'BLOCKED: the orchestrator cannot write source files directly (Iron Law 3).\n' >&2
printf 'Path is git-tracked or a net-new file in a tracked directory:\n  %s\n' "$FILE_PATH" >&2
printf 'Delegate the change to a worktree subagent.\n' >&2
exit 2
