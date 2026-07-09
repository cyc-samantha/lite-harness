#!/usr/bin/env bash
# lite-paths.sh — single source of truth for the lite plugin's writable state
# location and the shared "which run is active" selection logic. Sourced by the
# hooks that need to find run state (session-notice, state-checkpoint) and by the
# guards that only enforce while a run is in flight (orchestrator/main-branch).
#
# WHY the fallback chain: Claude Code sets CLAUDE_PLUGIN_ROOT (the plugin's
# install dir, read-only) but does NOT set CLAUDE_PLUGIN_DATA for plugins. So a
# bare "$CLAUDE_PLUGIN_DATA/runs" reference resolves to "/runs" and silently
# breaks. This mirrors the heavy harness HARNESS_DATA pattern: prefer the
# plugin-data dir, then the config dir, then ~/.claude — always resolvable.
LITE_DATA="${CLAUDE_PLUGIN_DATA:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/lite"

# Extracts a YAML frontmatter scalar from a STATE.md-shaped file. Empty output
# means "not present / no frontmatter". Scans only the leading `---`…`---` block.
lite_frontmatter_value() {
  local file="$1" key="$2"
  awk -v key="$key" '
    NR==1 && $0!="---" { exit }
    NR>1 && $0=="---"  { exit }
    NR>1 && $0 ~ ("^" key ":") { sub("^" key ": *", ""); gsub(/^"|"$/, ""); print; exit }
  ' "$file"
}

# Prints the path of the most-recently-active non-`done` run's STATE.md (or
# nothing). Selection: skip `phase: done`, prefer `last_seen` over `created`.
# Shared by session-notice.sh (what to announce) and state-checkpoint.sh (what
# to stamp) so both agree on the same run.
lite_select_active_run() {
  local runs_dir="$LITE_DATA/runs" state_file phase stamp best_file="" best_stamp=""
  [[ -d "$runs_dir" ]] || return 0
  for state_file in "$runs_dir"/*/STATE.md; do
    [[ -f "$state_file" ]] || continue
    phase="$(lite_frontmatter_value "$state_file" "phase")"
    [[ "$phase" == "done" ]] && continue
    stamp="$(lite_frontmatter_value "$state_file" "last_seen")"
    [[ -z "$stamp" ]] && stamp="$(lite_frontmatter_value "$state_file" "created")"
    [[ -z "$stamp" ]] && continue
    if [[ -z "$best_stamp" || "$stamp" > "$best_stamp" ]]; then
      best_stamp="$stamp"
      best_file="$state_file"
    fi
  done
  [[ -n "$best_file" ]] && printf '%s' "$best_file"
}

# Cheap existence check: is ANY non-`done` run present? Lighter than
# lite_select_active_run — it does not rank, it stops at the first hit. Used by
# the usability guards to decide whether to enforce at all.
#
# WHY fail-open here (return 1 = "no active run" when the dir is absent): these
# guards protect Iron Laws 3/4 DURING a lite run; when no run is in flight they
# would only obstruct ordinary interactive use. Per Iron Law 8 a gate that
# cannot evaluate its condition fails safe — and for a usability guard the safe
# default is "allow", since its absence compromises no boundary when nothing is
# being built. (Contrast: the guards' OWN block/allow verdict on a real write
# still fails closed once we know a run is active.)
lite_has_active_run() {
  local runs_dir="$LITE_DATA/runs" state_file phase
  [[ -d "$runs_dir" ]] || return 1
  for state_file in "$runs_dir"/*/STATE.md; do
    [[ -f "$state_file" ]] || continue
    phase="$(lite_frontmatter_value "$state_file" "phase")"
    [[ "$phase" != "done" ]] && return 0
  done
  return 1
}
