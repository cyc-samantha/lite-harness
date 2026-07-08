#!/usr/bin/env bash
# session-notice.sh — SessionStart hook (lite). Per PLAN.md §5, prints (does
# NOT auto-invoke) a one-line notice when a non-done /lite:build run exists:
#   "Lite run '<slug>' is in <phase> — run /lite:resume to continue."
#
# Printing instead of auto-resuming keeps startup cheap and leaves control
# with the user (PLAN.md §5). This is advisory UX, not a security or
# correctness gate (no test-mutation, no protected write, no blocking
# decision) — a single smoke test covering "prints when a run exists" /
# "no-ops silently when none exist" is sufficient, not the full Iron Law 8
# two-test treatment.
#
# Contract: reads $CLAUDE_PLUGIN_DATA/runs/*/STATE.md, picks the most
# recently active non-done run (by last_seen, falling back to created),
# prints one line, exits 0. Never mutates a STATE.md, never spawns anything.

set -uo pipefail

RUNS_DIR="${CLAUDE_PLUGIN_DATA:-}/runs"
[[ -n "${CLAUDE_PLUGIN_DATA:-}" && -d "$RUNS_DIR" ]] || exit 0

frontmatter_value() {
  local file="$1" key="$2"
  awk -v key="$key" '
    NR==1 && $0!="---" { exit }
    NR>1 && $0=="---"  { exit }
    NR>1 && $0 ~ ("^" key ":") { sub("^" key ": *", ""); gsub(/^"|"$/, ""); print; exit }
  ' "$file"
}

best_file=""
best_stamp=""
for state_file in "$RUNS_DIR"/*/STATE.md; do
  [[ -f "$state_file" ]] || continue
  phase="$(frontmatter_value "$state_file" "phase")"
  [[ "$phase" == "done" ]] && continue
  stamp="$(frontmatter_value "$state_file" "last_seen")"
  [[ -z "$stamp" ]] && stamp="$(frontmatter_value "$state_file" "created")"
  [[ -z "$stamp" ]] && continue
  if [[ -z "$best_stamp" || "$stamp" > "$best_stamp" ]]; then
    best_stamp="$stamp"
    best_file="$state_file"
  fi
done

[[ -n "$best_file" ]] || exit 0

slug="$(basename "$(dirname "$best_file")")"
phase="$(frontmatter_value "$best_file" "phase")"
[[ -n "$phase" ]] || exit 0

printf "Lite run '%s' is in %s — run /lite:resume to continue.\n" "$slug" "$phase"
exit 0
