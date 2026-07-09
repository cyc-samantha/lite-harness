#!/usr/bin/env bash
# install-tools.sh — provision the tools setup.sh checks for (jq, gh, bats) on
# Linux / Claude Code Cloud, where they usually aren't preinstalled the way
# they are on a macOS dev machine. No-ops per-tool when already present.
#
# Usage: bash scripts/install-tools.sh [--yes]
#   --yes   run the package-manager install non-interactively (apt-get -y).
#           Without it, missing tools are reported but not installed.

set -uo pipefail

ASSUME_YES=0
[[ "${1:-}" == "--yes" ]] && ASSUME_YES=1

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RESET='\033[0m'

have() { command -v "$1" >/dev/null 2>&1; }

apt_install() {
  local pkg="$1"
  if ! have apt-get; then
    printf '%bno apt-get on this system — install %s manually%b\n' "$YELLOW" "$pkg" "$RESET"
    return 1
  fi
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg"
  else
    printf '%bwould run: apt-get install -y %s (pass --yes to actually install)%b\n' "$YELLOW" "$pkg" "$RESET"
    return 1
  fi
}

install_jq() {
  have jq && { printf '%bjq already present%b\n' "$GREEN" "$RESET"; return 0; }
  apt_install jq
}

install_gh() {
  have gh && { printf '%bgh already present%b\n' "$GREEN" "$RESET"; return 0; }
  apt_install gh
}

install_bats() {
  have bats && { printf '%bbats already present%b\n' "$GREEN" "$RESET"; return 0; }
  apt_install bats
}

printf 'Installing tools for lite-harness (jq, gh, bats)...\n'
install_jq
install_gh
install_bats

printf '\nDone. Run bash ~/.claude/setup.sh next to verify.\n'
