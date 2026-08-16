#!/usr/bin/env bash
# bash-boundary.sh — PreToolUse Bash hook.
#
# worktree-boundary.sh answers "may this write happen here" for Write and Edit.
# Nothing asked it of Bash, so `sed -i` on a file outside the worktree, a
# redirect into a home directory, and `rm -rf` on an unset variable all went
# through a boundary the repository's own rules said was closed.
#
# WHAT THIS IS. A net for accidents, in the sense secret-guard.sh means it: the
# common mistake is caught and nothing more is claimed. It is NOT a sandbox, and
# reading it as one would be the more dangerous error. This hook inspects a
# command STRING, while capability belongs to the PROCESS that string starts,
# and the two are one indirection apart — `node ./fix.js` is a legal in-worktree
# write followed by a program free to write anywhere. Every command any allowlist
# would permit, gate commands included, is an arbitrary program. What actually
# bounds a run's reach is what it was spawned holding; see engine/environment.ts.
#
# So the detection here is knowingly incomplete and the DECISION is closed: the
# verb table below will never enumerate every way to write a file, but any target
# it does find must be PROVABLY inside this run's worktree or the command is
# refused. Undecidable and outside are the same answer.
#
# Iron Law 8 (fail-closed): a target containing a variable or a substitution
# cannot be resolved by a hook that does not run the shell, so it blocks. This is
# what catches the accident the whole guard exists for — `rm -rf "$BUILD_DIR"/`
# where the variable is unset expands to `rm -rf /`, and at that moment nothing
# in the model's reasoning has gone wrong. Reverting the `exit 2` in `block`
# turns the block tests RED.
#
# RUN-SCOPED via $LITE_WORKTREE, like the other guards. Outside a run there is no
# worktree to be inside of and the hook allows. `LITE_GUARDS=off` disables it.

set -uo pipefail

[[ "${LITE_GUARDS:-}" == "off" ]] && exit 0

WORKTREE="${LITE_WORKTREE:-}"
[[ -z "$WORKTREE" ]] && exit 0

block() {
  printf 'BLOCKED: this run may only write inside its own worktree.\n' >&2
  printf '  worktree: %s\n  in:       %s\n  target:   %s\n' "$WORKTREE" "${2:-<unevaluable>}" "${1:-<unevaluable>}" >&2
  printf 'A target built from a variable is refused because this guard cannot resolve it.\n' >&2
  printf 'Use a path relative to the worktree, which is where the run already stands.\n' >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || block "" "jq is unavailable, so the command cannot be read"

INPUT="$(cat 2>/dev/null || true)"
# SAFETY: only this hook's own matcher routes calls here, so anything arriving is
# a Bash call. A payload that will not parse is therefore a Bash call this guard
# cannot read — not an unrelated tool — and reading it as the latter is how an
# unevaluable input becomes an allow.
printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1 || block "" "the tool call could not be parsed"

TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

# Knowingly incomplete — see the header. These are the verbs whose whole purpose
# is to change a file, which is what makes a stray absolute path among their
# arguments an accident rather than a normal read.
_DESTRUCTIVE_VERBS='rm|rmdir|mv|cp|dd|truncate|shred|chmod|chown|chgrp|ln|install|tee|mkdir|touch|rsync'

# Verbs whose earlier arguments are sources being READ, so only the destination
# is a write. See the WHY in _verb_targets.
_COPY_VERBS='cp|rsync|install|ln'

# Writing to a terminal or discarding output is not reaching outside anything.
_is_discard_target() {
  [[ "$1" == /dev/null || "$1" == /dev/std* || "$1" == /dev/fd/* || "$1" == /dev/tty ]]
}

# SAFETY: the only two ways to say yes are a relative path while the shell still
# stands in the worktree, and an absolute path under it. Everything else —
# unresolvable, escaping, or simply elsewhere — is no.
_target_is_inside() {
  local target="$1" ambient="$2"
  [[ -z "$target" ]] && return 1
  _is_discard_target "$target" && return 0
  [[ "$target" == *'$'* || "$target" == *'`'* ]] && return 1
  # `~` is the home directory spelled without a slash, so it must not be read as
  # a relative path — that is how a dotfile write passes for a local one.
  [[ "$target" == '~'* ]] && return 1
  [[ "$target" == *".."* ]] && return 1
  [[ "$target" == "$WORKTREE" || "$target" == "$WORKTREE"/* ]] && return 0
  [[ "$target" != /* && "$ambient" == inside ]] && return 0
  return 1
}

_split_clauses() {
  printf '%s\n' "$1" | sed -E 's/\|\||&&|;|\|/\n/g'
}

# Redirect targets in a clause: `>f`, `>> f`, `2>f`, `&>f`. A descriptor
# duplication (`2>&1`) has no path after it and matches nothing, by construction
# of the trailing character class.
_redirect_targets() {
  printf '%s' "$1" | grep -oE '[0-9&]?>>?[[:space:]]*[^[:space:]&|;<>]+' 2>/dev/null |
    sed -E 's/^[0-9&]?>>?[[:space:]]*//'
}

# Arguments of a destructive verb, or nothing when the clause does not lead with
# one.
_verb_targets() {
  local clause="$1" verb argument
  local -a tokens
  read -ra tokens <<<"$clause"
  [[ ${#tokens[@]} -eq 0 ]] && return 0
  verb="${tokens[0]}"
  if [[ "$verb" == sed ]]; then
    [[ " ${tokens[*]} " == *" -i"* ]] || return 0
  elif [[ ! "$verb" =~ ^($_DESTRUCTIVE_VERBS)$ ]]; then
    return 0
  fi
  local -a positional
  while IFS= read -r argument; do
    [[ -n "$argument" ]] && positional+=("$argument")
  done < <(printf '%s\n' "${tokens[@]:1}" | grep -v '^-' 2>/dev/null)
  [[ ${#positional[@]} -eq 0 ]] && return 0

  # WHY the last argument only, for these: their earlier arguments are read, and
  # reading a template out of /usr/share is ordinary. `mv` is deliberately not
  # here — it removes its source, so its source is a write too. Over-blocking an
  # honest `cp` is how a guard earns a reputation that gets it switched off.
  if [[ "$verb" =~ ^($_COPY_VERBS)$ ]]; then
    printf '%s\n' "${positional[-1]}"
    return 0
  fi
  printf '%s\n' "${positional[@]}"
}

# `cd` moves the shell for every later clause, so it decides whether a relative
# target is still inside. A `cd` this guard cannot resolve makes every relative
# target after it unresolvable too.
#
# WHY no subshell modelling, unlike main-branch-guard.sh: not restoring the
# ambient state when a subshell closes leaves it marked outside for longer than
# the real shell would, which over-blocks. That is the safe direction, and the
# machinery to be exact here would not buy a stronger guarantee.
_ambient_after() {
  local clause="$1" current="$2" target
  [[ "$clause" =~ ^[[:space:]]*\(?[[:space:]]*cd([[:space:]]|$) ]] || { printf '%s' "$current"; return; }
  target="$(printf '%s' "$clause" | sed -E "s#^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+['\"]?([^'\"[:space:];&]*)['\"]?.*#\1#")"
  _target_is_inside "$target" "$current" && printf 'inside' || printf 'outside'
}

ambient=inside
while IFS= read -r clause; do
  [[ -z "${clause// /}" ]] && continue
  # Refused before any target is looked at: a run that needs to escalate has left
  # its boundary whatever it was going to do next, and the boundary is the point.
  [[ "$clause" =~ (^|[[:space:]])(sudo|doas)([[:space:]]|$) ]] && block "privilege escalation" "$clause"
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    _target_is_inside "$target" "$ambient" || block "$target" "$clause"
  done < <({ _redirect_targets "$clause"; _verb_targets "$clause"; })
  ambient="$(_ambient_after "$clause" "$ambient")"
done < <(_split_clauses "$COMMAND")

exit 0
