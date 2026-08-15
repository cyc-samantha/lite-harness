#!/usr/bin/env bash
# audit-logger.sh — PostToolUse hook. Appends one line per tool call to the run's
# audit log.
#
# One append-only stream serves three readers: read line by line it is the audit
# trail, aggregated it is the cost and pass-rate telemetry, and projected to its
# latest state it is the execution board. Building three systems for those would
# guarantee they disagree.
#
# The engine forwards these lines upstream as checkpoints. Writing them locally
# first means a run that loses its network still has a complete record, and a
# tool call is never delayed on an HTTP round trip.
#
# RUN-SCOPED: without $LITE_RUN_DIR there is no run to log against and the hook
# is a no-op. It never blocks — an audit failure must not stop the work it is
# recording, or the first flaky disk turns into a stalled run.

set -uo pipefail

RUN_DIR="${LITE_RUN_DIR:-}"
[[ -z "$RUN_DIR" ]] && exit 0
mkdir -p "$RUN_DIR" 2>/dev/null || exit 0

INPUT="$(cat 2>/dev/null || true)"
[[ -z "$INPUT" ]] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Only the shape of the call is recorded — path, command, exit status. Tool
# output is not, because it is where a credential would appear if one ever did.
printf '%s' "$INPUT" | jq -c \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg run "${LITE_RUN_ID:-unknown}" \
  --arg role "${LITE_ROLE:-orchestrator}" \
  '{at: $at, run_id: $run, role: $role,
    tool: (.tool_name // "unknown"),
    path: (.tool_input.file_path // null),
    command: (.tool_input.command // null)}' \
  >> "$RUN_DIR/audit.jsonl" 2>/dev/null || exit 0

exit 0
