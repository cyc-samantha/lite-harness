#!/usr/bin/env bash
# secret-guard.sh — PreToolUse Write|Edit hook.
#
# Stops a credential being written into the repository. This catches the common
# accident — a key pasted into a config file, a token left in a fixture — and
# claims nothing more. It is not a secret scanner, and it is not the reason
# credentials stay safe: that comes from the run never holding a credential it
# does not need. This is the last net, not the first.
#
# Only high-confidence shapes are matched. A guard that fires on anything
# resembling a password teaches people to disable it, and a disabled guard
# catches nothing at all.
#
# RUN-SCOPED via $LITE_WORKTREE, like the boundary guard. `LITE_GUARDS=off`
# disables it outright.
#
# SAFETY: with a run in flight, unreadable input blocks. A write whose content
# cannot be inspected is a write that cannot be cleared.

set -uo pipefail

[[ "${LITE_GUARDS:-}" == "off" ]] && exit 0
[[ -z "${LITE_WORKTREE:-}" ]] && exit 0

block() {
  printf 'BLOCKED: this looks like a credential (%s).\n' "$1" >&2
  printf 'Secrets never go in the repository. Use the environment.\n' >&2
  exit 2
}

command -v jq >/dev/null 2>&1 && command -v grep >/dev/null 2>&1 || block "content could not be inspected"

INPUT="$(cat 2>/dev/null || true)"
CONTENT="$(printf '%s' "$INPUT" | jq -r '[.tool_input.content, .tool_input.new_string] | map(select(. != null)) | join("\n")' 2>/dev/null)"
[[ -z "$CONTENT" ]] && exit 0

# `-e` is load-bearing: the private-key pattern starts with a dash, and without it
# grep reads the pattern as options and silently matches nothing.
matches() { printf '%s' "$CONTENT" | grep -qE -e "$1"; }

matches '-----BEGIN [A-Z ]*PRIVATE KEY-----' && block "private key block"
matches 'gh[pousr]_[A-Za-z0-9]{36,}' && block "GitHub token"
matches 'AKIA[0-9A-Z]{16}' && block "AWS access key id"
matches 'sk-(ant-)?[A-Za-z0-9_-]{32,}' && block "API secret key"
matches 'xox[baprs]-[A-Za-z0-9-]{10,}' && block "Slack token"

exit 0
