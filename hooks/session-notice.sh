#!/usr/bin/env bash
# session-notice.sh — SessionStart hook (lite). Per PLAN.md §5, prints (does
# NOT auto-invoke) a one-line notice when a non-done /lite:build run exists:
#   "Lite run '<slug>' is in <phase> — run /lite:resume to continue."
#
# Printing instead of auto-resuming keeps startup cheap and leaves control
# with the user (PLAN.md §5). This is advisory UX, not a security or
# correctness gate (no test-mutation, no protected write, no blocking
# decision) — a single smoke test covering "prints when a run exists" /
# "no-ops when none exist" is sufficient, not the full Iron Law 8 two-test
# treatment.
#
# Contract: reads the shared run store (see hooks/_lib/lite-paths.sh —
# resolves via ${CLAUDE_PLUGIN_DATA:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/lite/
# runs, never a bare unset "$CLAUDE_PLUGIN_DATA"), picks the most recently
# active non-done run, prints one line, exits 0. Never mutates, never spawns.

set -uo pipefail

_LITE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/_lib" && pwd 2>/dev/null)" || exit 0
# shellcheck source=hooks/_lib/lite-paths.sh
source "$_LITE_LIB_DIR/lite-paths.sh" 2>/dev/null || exit 0

best_file="$(lite_select_active_run)"
[[ -n "$best_file" ]] || exit 0

slug="$(basename "$(dirname "$best_file")")"
phase="$(lite_frontmatter_value "$best_file" "phase")"
[[ -n "$phase" ]] || exit 0

printf "Lite run '%s' is in %s — run /lite:resume to continue.\n" "$slug" "$phase"
exit 0
