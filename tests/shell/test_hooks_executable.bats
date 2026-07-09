#!/usr/bin/env bats
# Packaging invariants for hooks/*.sh, checked against the GIT INDEX (stage 0),
# not the local working tree — so they hold regardless of a checkout's
# core.autocrlf / filemode config.
#
# F1: every hook is committed executable (mode 100755). The hooks.json launcher
#     is `[ -x "$h" ] && exec "$h" || exit 0`, so a non-executable hook silently
#     no-ops instead of enforcing — a mode regression disables every guard.
# F2: no hook blob carries a carriage return. CRLF blobs would break the shebang
#     dispatch and the awk frontmatter parsing on a clean clone.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

@test "F1: every hooks/*.sh is mode 100755 in the git index" {
  cd "$REPO"
  local modes
  modes="$(git ls-files -s hooks/*.sh | awk '{print $1}' | sort -u)"
  [ "$modes" = "100755" ]
}

@test "F2: no hooks/*.sh blob contains a carriage return" {
  cd "$REPO"
  local total=0 f n
  for f in $(git ls-files 'hooks/*.sh'); do
    n="$(git show ":$f" | grep -c $'\r' || true)"
    total=$((total + n))
  done
  [ "$total" -eq 0 ]
}
