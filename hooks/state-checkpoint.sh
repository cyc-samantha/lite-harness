#!/usr/bin/env bash
# state-checkpoint.sh — Stop + SubagentStop hook (lite). Supports usage-limit /
# crash resume (PLAN.md §5) by stamping a fresh `last_seen` (current UTC) and,
# when provided, the current `phase` into a run's STATE.md YAML frontmatter.
#
# Contract:
#   $1               = path to the run's STATE.md (falls back to $LITE_STATE_FILE)
#   $LITE_PHASE      = optional; when non-empty, overwrites the frontmatter phase
#
# Iron Law 8 (fail-closed / no-op-safe): the hook refuses to touch a file whose
# frontmatter it cannot locate. The single load-bearing gate is:
#     [[ -n "$fence_end" ]] || exit 0
# It requires line 1 to be `---` AND a closing `---` to exist. Only past that
# gate does the stamper run — and the stamper assumes a valid block, so removing
# the gate makes it inject `last_seen` into a non-frontmatter file (corrupting
# it), which turns the "leaves it unchanged" test RED. The $1/-f guard is the
# unevaluable-target (missing/empty path) no-op.
#
# SELF-LOCATION: env vars exported in one Bash tool call do NOT persist to this
# hook's process on a later Stop/SubagentStop, so $LITE_STATE_FILE plumbing is
# unreliable. When neither $1 nor $LITE_STATE_FILE is given, the hook locates the
# active run itself via the shared selector (hooks/_lib/lite-paths.sh) — the same
# "non-done, prefer last_seen over created" logic session-notice.sh uses. Zero
# runs → nothing to stamp → no-op (still fail-closed: never creates a file).

set -uo pipefail

STATE_FILE="${1:-${LITE_STATE_FILE:-}}"
if [[ -z "$STATE_FILE" ]]; then
  _LITE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/_lib" && pwd 2>/dev/null)" || exit 0
  # shellcheck source=hooks/_lib/lite-paths.sh
  source "$_LITE_LIB_DIR/lite-paths.sh" 2>/dev/null || exit 0
  STATE_FILE="$(lite_select_active_run)"
fi
[[ -n "$STATE_FILE" && -f "$STATE_FILE" && -r "$STATE_FILE" ]] || exit 0

# Line number of the closing `---`, but only when line 1 opens the frontmatter.
# Empty result = no valid frontmatter block to stamp.
fence_end="$(awk 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{print NR; exit}' "$STATE_FILE")"
[[ -n "$fence_end" ]] || exit 0

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
phase="${LITE_PHASE:-}"

# Does a key already exist inside the frontmatter block? (scan lines 2..fence_end-1)
frontmatter_has() {
  awk -v key="$1" -v end="$fence_end" \
    'NR>1 && NR<end && $0 ~ ("^" key ":") {found=1} END{exit !found}' "$STATE_FILE"
}

has_last_seen=0; frontmatter_has "last_seen" && has_last_seen=1
has_phase=0;     frontmatter_has "phase"     && has_phase=1

tmp="$(mktemp 2>/dev/null)" || exit 0
awk -v now="$now" -v phase="$phase" -v end="$fence_end" \
    -v has_ls="$has_last_seen" -v has_ph="$has_phase" '
  NR==1 {
    print
    if (!has_ls)                 print "last_seen: " now
    if (phase != "" && !has_ph)  print "phase: " phase
    next
  }
  NR>1 && NR<end && /^last_seen:/          { print "last_seen: " now; next }
  NR>1 && NR<end && phase != "" && /^phase:/ { print "phase: " phase; next }
  { print }
' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE" || rm -f "$tmp"
exit 0
