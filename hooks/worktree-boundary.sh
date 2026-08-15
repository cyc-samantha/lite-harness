#!/usr/bin/env bash
# worktree-boundary.sh — PreToolUse Write|Edit hook.
#
# A run owns exactly one worktree and may write nowhere else. This is what lets
# several runs share a machine without one of them quietly editing another's
# checkout, and what stops a run reaching into the target repository's main
# checkout at all.
#
# The guard is role-agnostic on purpose: it never asks which agent is writing,
# only where. Role-coupled guards need editing every time the roster changes,
# and a guard nobody maintains is a guard that gets switched off.
#
# RUN-SCOPED: enforcement depends on $LITE_WORKTREE, which the engine exports
# when it starts a run. Outside a run there is no boundary to enforce and the
# hook allows everything — otherwise it would block ordinary interactive edits in
# every project the plugin is installed in. `LITE_GUARDS=off` disables it
# outright.
#
# SAFETY: once a run IS in flight, every undecidable case blocks. An empty
# file_path, an unresolvable worktree root, and a missing jq are all inputs this
# hook cannot evaluate, and a write it cannot evaluate is a write it cannot
# permit. Reverting any of those `exit 2` lines turns its test RED.

set -uo pipefail

[[ "${LITE_GUARDS:-}" == "off" ]] && exit 0

WORKTREE="${LITE_WORKTREE:-}"
[[ -z "$WORKTREE" ]] && exit 0

block() {
  printf 'BLOCKED: this run may only write inside its own worktree.\n' >&2
  printf '  worktree: %s\n  attempted: %s\n' "$WORKTREE" "${1:-<unevaluable>}" >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || block "jq is unavailable, so the target cannot be read"

INPUT="$(cat 2>/dev/null || true)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[[ -z "$FILE_PATH" ]] && block ""

# `realpath -m` resolves `..` and symlinks without requiring the path to exist,
# which matters because the write being judged is usually a file that does not
# exist yet.
ROOT="$(realpath -m -- "$WORKTREE" 2>/dev/null)" || block "$FILE_PATH"
TARGET="$(realpath -m -- "$FILE_PATH" 2>/dev/null)" || block "$FILE_PATH"
[[ -z "$ROOT" || -z "$TARGET" ]] && block "$FILE_PATH"

[[ "$TARGET" == "$ROOT" || "$TARGET" == "$ROOT"/* ]] && exit 0
block "$FILE_PATH"
