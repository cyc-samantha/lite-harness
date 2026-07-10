#!/usr/bin/env bash
# main-branch-guard.sh — PreToolUse Bash hook (lite). Enforces Iron Law 4:
# REPO_ROOT HEAD stays on `main`; all HEAD-mutating git commands run via
# worktree delegation. Trimmed port of the heavy harness main-branch-guard.
#
# Blocks bare HEAD-mutating commands: git checkout / switch / reset --hard /
# merge / rebase, and gh pr create. A command is ALLOWED only when it carries
# a recognized delegation prefix — `git -C <path> ...`, `git --git-dir=<path>
# ...`, or a leading `cd <path> && ...` — AND the delegation target is a
# pinned worktree: it must contain `.claude/worktrees/` (the convention pinned
# by `skills/build/SKILL.md` Step 2), or be an unresolved shell variable
# reference (e.g. `"$WORKTREE"`) matching the orchestrator's own delegation
# convention. `.`, an empty target, and REPO_ROOT itself never contain that
# substring, so they are rejected as delegation targets (S2). Intervening git
# global flags (e.g. `--work-tree=<path>`) between `git` and the subcommand no
# longer hide a forbidden command from detection.
#
# Iron Law 8 (fail-closed): a forbidden command whose delegation target cannot
# be evaluated (empty `cd` target, or a target that isn't a worktree path) is
# BLOCKED, never silently allowed. Reverting the final `exit 2` makes the
# block tests go RED.
#
# Reads Claude Code PreToolUse JSON from stdin: {tool_name, tool_input.command}.
#
# RUN-SCOPED (F6): this is a usability guard, not an always-on control. It only
# enforces while a lite run is in flight — outside a /lite:build run it would
# just block ordinary interactive git in every project the plugin is enabled in.
# `LITE_GUARDS=off` force-disables it regardless of run state. If run-state can't
# be evaluated, lite_has_active_run reports "no active run" and we allow — the
# fail-safe default for a usability guard (see lite-paths.sh for the rationale).

set -uo pipefail

[[ "${LITE_GUARDS:-}" == "off" ]] && exit 0
_LITE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/_lib" && pwd 2>/dev/null)" || exit 0
# shellcheck source=hooks/_lib/lite-paths.sh
source "$_LITE_LIB_DIR/lite-paths.sh" 2>/dev/null || exit 0
lite_has_active_run || exit 0

INPUT="$(cat 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# Non-Bash tools and empty commands are genuine no-ops — nothing to gate.
[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

# Zero or more intervening `git` global flag tokens between `git` and its
# subcommand — either single tokens (`--work-tree=<path>`) or a flag plus its
# own value token (`-C <path>`) — so a flagged invocation doesn't hide a
# forbidden subcommand from these regexes.
_GIT_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*'

is_forbidden_command() {
  local cmd="$1"
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git${_GIT_FLAGS}[[:space:]]+(checkout|switch|merge|rebase)([[:space:]]|$) ]] && return 0
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git${_GIT_FLAGS}[[:space:]]+reset[[:space:]] ]] && [[ "$cmd" =~ --hard ]] && return 0
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

# The dequoted target following a `-C ` or `--git-dir=` flag anywhere in $cmd.
# Empty when the flag is absent.
_flag_target() {
  local cmd="$1" flag_pattern="$2" quoted unquoted
  quoted="$(printf '%s' "$cmd" | sed -E "s#.*${flag_pattern}['\"]([^'\"]*)['\"].*#\1#")"
  [[ "$quoted" != "$cmd" ]] && { printf '%s' "$quoted"; return; }
  unquoted="$(printf '%s' "$cmd" | sed -E "s#.*${flag_pattern}([^[:space:]]+).*#\1#")"
  [[ "$unquoted" != "$cmd" ]] && printf '%s' "$unquoted"
}

# S2: a delegation target is only valid when it's the pinned worktree
# convention (`.claude/worktrees/<slug>`, skills/build/SKILL.md Step 2) or an
# unresolved shell variable reference (e.g. `$WORKTREE`, `${WORKTREE}`) — the
# orchestrator's own delegation idiom, which this hook cannot resolve to a
# literal path. `.`, empty, and REPO_ROOT itself never satisfy either check.
_is_worktree_delegation_target() {
  local target="$1"
  [[ -z "$target" ]] && return 1
  [[ "$target" == *".claude/worktrees/"* ]] && return 0
  [[ "$target" =~ ^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$ ]] && return 0
  return 1
}

has_valid_delegation() {
  local cmd="$1" target

  target="$(_flag_target "$cmd" '-C[[:space:]]+')"
  _is_worktree_delegation_target "$target" && return 0

  target="$(_flag_target "$cmd" '--git-dir=')"
  _is_worktree_delegation_target "$target" && return 0

  if [[ "$cmd" =~ ^[[:space:]]*\(?[[:space:]]*cd[[:space:]] ]]; then
    target="$(cd_delegation_target "$cmd")"
    # Fail-closed: an empty/non-worktree cd target is not valid delegation.
    _is_worktree_delegation_target "$target" && return 0
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
