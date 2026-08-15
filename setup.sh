#!/usr/bin/env bash
# setup.sh — Bootstrap script for a fresh ~/.claude install of lite-harness.
# Idempotent: safe to run multiple times. Continues past soft failures so a
# missing optional tool doesn't abort the whole run — a missing optional tool is reported, not fatal.
# Usage: bash ~/.claude/setup.sh
#
# On Linux / Claude Code Cloud, provision tools first:
#   bash ~/.claude/scripts/install-tools.sh --yes && bash ~/.claude/setup.sh

set -uo pipefail

_SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

OK=()
WARN=()
FAIL=()

check_tool() {
  local name="$1" hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    OK+=("$name")
  else
    WARN+=("$name — $hint")
  fi
}

printf '\n%bStep 1: Checking required tools%b\n' "$BLUE" "$RESET"
check_tool jq "hooks parse tool-call JSON with it; without it the guards degrade to no-ops"
check_tool gh "the pull-request step needs it (and \`gh auth status\` to be logged in)"
check_tool bats "only needed to run tests/shell/ — not needed to use the harness"
check_tool git "required — lite-harness is unusable without git"

printf '\n%bStep 2: Marking hooks executable%b\n' "$BLUE" "$RESET"
if compgen -G "$_SETUP_DIR/hooks/*.sh" >/dev/null; then
  chmod +x "$_SETUP_DIR"/hooks/*.sh 2>/dev/null && OK+=("hooks/*.sh chmod +x") || FAIL+=("chmod hooks/*.sh")
else
  FAIL+=("no hooks/*.sh found under $_SETUP_DIR — packaging looks broken")
fi

printf '\n%bStep 3: Verifying settings.json is valid JSON%b\n' "$BLUE" "$RESET"
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$_SETUP_DIR/settings.json" 2>/dev/null; then
    OK+=("settings.json valid")
  else
    FAIL+=("settings.json is not valid JSON")
  fi
else
  WARN+=("python3 — skipped settings.json validation")
fi

printf '\n%b=== Summary ===%b\n' "$BLUE" "$RESET"
[[ ${#OK[@]} -gt 0 ]] && printf '%bOK:%b %s\n' "$GREEN" "$RESET" "${OK[*]}"
[[ ${#WARN[@]} -gt 0 ]] && printf '%bWARN:%b\n' "$YELLOW" "$RESET" && printf '  - %s\n' "${WARN[@]}"
[[ ${#FAIL[@]} -gt 0 ]] && printf '%bFAIL:%b\n' "$RED" "$RESET" && printf '  - %s\n' "${FAIL[@]}"

if [[ ${#FAIL[@]} -gt 0 ]]; then
  printf '\n%bSetup finished with failures — see FAIL list above.%b\n' "$RED" "$RESET"
  exit 1
fi

printf '\n%blite-harness is ready. Next, in the repository you want it to work on:%b\n' "$GREEN" "$RESET"
printf '  1. add .harness/project.yaml   (see examples/factory-map.project.yaml)\n'
printf '  2. export LITE_TARGET=<that repo> LITE_SOURCE_URL=<work source>\n'
printf '  3. /run <contract-id>\n'
exit 0
