#!/usr/bin/env bash
# code-shape-check.sh — PostToolUse Write|Edit hook (lite). ADVISORY-only port of
# the heavy harness code-shape rules (rules/core.md § Code Shape Rules). It warns
# on stderr about too-long functions and too-many-param signatures for JS/TS and
# Python, then ALWAYS exits 0 — it never blocks an edit. The code-reviewer
# enforces shape at the Review phase (PLAN.md §3).
#
# Iron Law 8 posture: this gate is advisory, so its fail-closed behaviour is
# degrade-safe — on any unevaluable input (empty path, missing file, unknown
# language, absent jq) it emits no warning and exits 0 rather than crashing or
# blocking. Reverting the always-exit-0 contract (e.g. exit 2 on a violation)
# turns the "warns but status is 0" test RED.
#
# Heuristics are grep/regex-based (like the heavy harness), not a full AST parse.
# Thresholds: functions > 12 lines, signatures > 4 params.

set -uo pipefail

FN_LINE_LIMIT="${LITE_FN_LINE_LIMIT:-12}"
PARAM_LIMIT="${LITE_PARAM_LIMIT:-4}"

INPUT="$(cat 2>/dev/null || true)"
FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"

[[ -z "$FILE_PATH" ]] && exit 0
[[ -f "$FILE_PATH" ]] && [[ -r "$FILE_PATH" ]] || exit 0

case "$FILE_PATH" in
  *.js|*.jsx|*.ts|*.tsx) lang="js" ;;
  *.py)                  lang="py" ;;
  *)                     exit 0 ;;
esac

warn_long_functions() {
  awk -v limit="$FN_LINE_LIMIT" -v lang="$lang" '
    function flush(end,   len) {
      if (!open) return
      len = end - start
      if (len > limit)
        printf "CODE-SHAPE (advisory): %s:%d function is %d lines (limit %d)\n", FILENAME, start, len, limit > "/dev/stderr"
      open = 0
    }
    lang == "py" {
      if ($0 ~ /^[[:space:]]*def[[:space:]]/) {
        flush(NR)
        match($0, /^[[:space:]]*/); indent = RLENGTH
        start = NR; open = 1; next
      }
      if (open && $0 ~ /[^[:space:]]/) {
        match($0, /^[[:space:]]*/)
        if (RLENGTH <= indent) flush(NR)
      }
      next
    }
    lang == "js" {
      if (!open && $0 ~ /(function|=>|\)[[:space:]]*\{)/ && $0 ~ /\{/) {
        start = NR; open = 1; depth = 0
      }
      if (open) {
        depth += gsub(/\{/, "{")
        depth -= gsub(/\}/, "}")
        if (depth <= 0) flush(NR)
      }
    }
    END { flush(NR + 1) }
  ' "$FILE_PATH"
}

warn_wide_signatures() {
  awk -v limit="$PARAM_LIMIT" -v lang="$lang" '
    function count_params(line,   inner, n, i, c) {
      sub(/^[^(]*\(/, "", line)
      sub(/\).*$/, "", line)
      gsub(/[[:space:]]/, "", line)
      if (line == "") return 0
      n = 1
      for (i = 1; i <= length(line); i++) { c = substr(line, i, 1); if (c == ",") n++ }
      return n
    }
    {
      is_sig = (lang == "py") ? ($0 ~ /^[[:space:]]*def[[:space:]]+[A-Za-z_]/) \
                              : ($0 ~ /(function[[:space:]]+[A-Za-z_$]|=>|\)[[:space:]]*\{)/)
      if (is_sig && $0 ~ /\(/) {
        p = count_params($0)
        if (p > limit)
          printf "CODE-SHAPE (advisory): %s:%d signature has %d params (limit %d)\n", FILENAME, NR, p, limit > "/dev/stderr"
      }
    }
  ' "$FILE_PATH"
}

warn_long_functions
warn_wide_signatures
exit 0
