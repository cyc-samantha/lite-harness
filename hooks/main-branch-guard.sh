#!/usr/bin/env bash
# main-branch-guard.sh — PreToolUse Bash hook (lite). Enforces Iron Law 4:
# REPO_ROOT HEAD stays on `main`; all HEAD-mutating git commands run via
# worktree delegation. Trimmed port of the heavy harness main-branch-guard.
#
# Two separate rules live here, and they are separate on purpose.
#
# (1) HEAD mutation — git checkout / switch / reset --hard / merge / rebase, and
# gh pr create — is excused by worktree delegation, because a worktree HEAD is
# the run's own to move.
#
# (2) Moving a SHARED ref is excused by nothing. `git -C "$WORKTREE" push origin
# main` is exactly as wrong as the bare form, so push is decided before the
# delegation logic and never reaches it. This closes a rule that was already
# written and had nothing behind it: rules/core.md says merging and releasing
# belong to whatever takes the candidate from here, while a run could force-push
# to the base branch and pass every guard in this repository.
#
# Blocks bare HEAD-mutating commands: git checkout / switch / reset --hard /
# merge / rebase, and gh pr create. A command is ALLOWED only when EVERY
# clause (split on `&&`/`||`/`;`/`|`) carrying a forbidden subcommand also
# carries its OWN recognized delegation, scoped to that clause's own `git`
# invocation — `git -C <path> ...`, `git --git-dir=<path> ...` — or an earlier
# `cd <path> && ...` / `cd <path>; ...` clause set the ambient directory to a
# valid worktree (cd persists for the rest of the shell invocation, matching
# the documented idiom), AND no SUBSEQUENT `cd` clause has since re-targeted
# the ambient directory elsewhere. The delegation target must be a pinned
# worktree: it must contain
# `.claude/worktrees/`, lie inside this run's own `$LITE_WORKTREE`, or be
# exactly the orchestrator's documented `$WORKTREE`/`${WORKTREE}`
# variable (optionally with a trailing subpath, e.g. `$WORKTREE/.git`) — no
# other bare shell variable (`$PWD`, `$HOME`, `$OLDPWD`, etc.) qualifies, and
# a target with a `/..` traversal component is rejected outright. `.`, an
# empty target, and REPO_ROOT itself never satisfy any of these checks (S2).
# A delegation token appearing elsewhere in the command — on an unrelated
# clause, or attached to a non-git token — does not launder a bare forbidden
# clause. Intervening git global flags (e.g. `--work-tree=<path>`) between
# `git` and the subcommand no longer hide a forbidden command from detection.
#
# Iron Law 8 (fail-closed): a forbidden command whose delegation target cannot
# be evaluated (empty `cd` target, or a target that isn't a worktree path) is
# BLOCKED, never silently allowed. Reverting the final `exit 2` makes the
# block tests go RED.
#
# Reads Claude Code PreToolUse JSON from stdin: {tool_name, tool_input.command}.
#
# RUN-SCOPED: this is a usability guard, not an always-on control. It only
# enforces while a run is in flight — outside a `/run` it would just block
# ordinary interactive git in every project the plugin is enabled in. A run is in
# flight exactly when the engine has exported `$LITE_WORKTREE`; unset means no
# run, and we allow. `LITE_GUARDS=off` force-disables it regardless.
#
# That allow-on-unset is deliberate and is NOT a fail-closed violation: with no
# run in flight there is no run-owned HEAD to protect, so there is no verdict to
# fail closed on. Once a run IS in flight, every undecidable delegation target
# blocks (Iron Law 8, above).

set -uo pipefail

[[ "${LITE_GUARDS:-}" == "off" ]] && exit 0
# A run is in flight exactly when the engine has exported its worktree. Outside a
# run there is no HEAD to protect and this would only obstruct ordinary git use.
[[ -z "${LITE_WORKTREE:-}" ]] && exit 0

INPUT="$(cat 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"

# Non-Bash tools and empty commands are genuine no-ops — nothing to gate.
[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

# Zero or more intervening `git` global flag tokens between `git` and its
# subcommand — either single tokens (`--work-tree=<path>`) or a flag plus its
# own value token (`-C <path>`) — so a flagged invocation doesn't hide a
# forbidden subcommand from these regexes.
_GIT_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*'

# Refs a run may never move. The run's own base comes from `$LITE_BASE` when the
# engine exports it; the literals stay regardless, because a run pushing to
# `production` is wrong even in a repository whose base is `develop`.
_PROTECTED_REFS='main|master|develop|release|staging|production|prod|trunk'

# Whether $segment (a git invocation from `git` onward) is a push, and whether
# this guard can PROVE its destination is a ref the run is allowed to move.
#
# Push is deliberately outside the delegation model above. Delegation excuses a
# HEAD mutation because a worktree HEAD is the run's own to move; it excuses
# nothing about a shared ref, and `git -C "$WORKTREE" push origin main` is
# exactly as wrong as the bare form.
#
# SAFETY (Iron Law 8): the allowed case is the narrow one. A push is permitted
# only when it carries no force flag, names a remote, and names a literal
# refspec whose destination is provably not protected. A bare `git push`
# (destination decided by upstream config this hook cannot read), a refspec
# built from a variable, and a `+refspec` force are all undecidable or
# destructive, and all block. Reverting the final `return 0` here turns the
# unevaluable-input tests RED.
# The arguments of a `git push`, or failure when this git invocation is not one.
# Global flags between `git` and its subcommand are stepped over, so a delegated
# `git -C <path> push ...` is recognised — delegation must not hide a push any
# more than it excuses one. Anchoring on the subcommand also keeps `git commit -m
# "push origin main"` from reading as a push.
_push_arguments() {
  local -a tokens
  local i=0
  read -ra tokens <<<"$1"
  while (( i < ${#tokens[@]} )); do
    case "${tokens[i]}" in
      -C|--git-dir|--work-tree|--namespace|-c) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [[ "${tokens[i]:-}" == push ]] || return 1
  printf '%s' "${tokens[*]:i+1}"
}

_is_forbidden_push() {
  local segment="$1" args token destination positionals=0
  local -a tokens
  args="$(_push_arguments "$segment")" || return 1
  [[ -z "$args" ]] && return 0
  [[ "$args" =~ (^|[[:space:]])(-f|--force|--force-with-lease)([=[:space:]]|$) ]] && return 0
  # A refspec assembled from a variable or a substitution is a destination this
  # hook cannot read, and an unreadable destination is not a safe one.
  [[ "$args" == *'$'* || "$args" == *'`'* ]] && return 0

  read -ra tokens <<<"$args"
  for token in "${tokens[@]}"; do
    [[ "$token" == -* ]] && continue
    positionals=$((positionals + 1))
    [[ "$token" == +* ]] && return 0
    destination="${token##*:}"
    destination="${destination#refs/heads/}"
    [[ "$destination" =~ ^($_PROTECTED_REFS)$ ]] && return 0
    [[ -n "${LITE_BASE:-}" && "$destination" == "$LITE_BASE" ]] && return 0
  done

  # With no remote and refspec spelled out, where this lands is decided by
  # upstream configuration the hook cannot read.
  (( positionals >= 2 )) || return 0
  return 1
}

has_forbidden_push() {
  local cmd="$1" clause segment
  while IFS= read -r clause; do
    segment="$(_git_segment "$clause")" || continue
    _is_forbidden_push "$segment" && return 0
  done < <(_split_clauses "$cmd")
  return 1
}

is_forbidden_command() {
  local cmd="$1"
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git${_GIT_FLAGS}[[:space:]]+(checkout|switch|merge|rebase)([[:space:]]|$) ]] && return 0
  [[ "$cmd" =~ (^|[^[:alnum:]_-])git${_GIT_FLAGS}[[:space:]]+reset[[:space:]] ]] && [[ "$cmd" =~ --hard ]] && return 0
  [[ "$cmd" =~ (^|[^[:alnum:]_-])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]] && return 0
  return 1
}

# The path token after a leading `cd `, dequoted. Empty when absent/malformed.
cd_delegation_target() {
  local cmd="$1" quoted unquoted
  quoted="$(printf '%s' "$cmd" | sed -E "s#^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+['\"]([^'\"]*)['\"].*#\1#")"
  [[ "$quoted" != "$cmd" ]] && { printf '%s' "$quoted"; return; }
  unquoted="$(printf '%s' "$cmd" | sed -E 's#^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+([^[:space:];&]*).*#\1#')"
  [[ "$unquoted" != "$cmd" ]] && printf '%s' "$unquoted"
}

# The dequoted target following a `-C ` or `--git-dir=` flag anywhere in $cmd.
# Empty when the flag is absent.
_flag_target() {
  local cmd="$1" flag_pattern="$2" quoted unquoted
  quoted="$(printf '%s' "$cmd" | sed -E "s#.*${flag_pattern}['\"]([^'\"]*)['\"].*#\1#")"
  [[ "$quoted" != "$cmd" ]] && { printf '%s' "$quoted"; return; }
  unquoted="$(printf '%s' "$cmd" | sed -E "s#.*${flag_pattern}([^[:space:]]+).*#\1#")"
  [[ "$unquoted" != "$cmd" ]] && printf '%s' "$unquoted"
}

# S2 (fix-cycle round 2): a delegation target is only valid when it's the
# pinned worktree convention (`.claude/worktrees/<slug>`, retained for worktrees
# this plugin did not create), this run's own worktree as exported in
# `$LITE_WORKTREE`, or the orchestrator's OWN delegation variable `$WORKTREE`
# / `${WORKTREE}` (optionally with a trailing subpath, e.g. `$WORKTREE/.git`
# for the `git --git-dir=` idiom) — never any other bare shell variable such as
# `$PWD`/`$HOME`/`$OLDPWD`, all of which resolve to REPO_ROOT or an
# orchestrator-adjacent directory in practice and were previously accepted by
# a too-broad "any identifier" regex (code-review + security-review finding,
# round 2). A target containing a `/..` traversal component is rejected
# outright even if it also contains the `.claude/worktrees/` substring — a
# substring match earlier in the path is not proof the resolved path stays
# inside it once `..` segments walk back out. `.`, empty, and REPO_ROOT itself
# never satisfy any of these checks.
_is_worktree_delegation_target() {
  local target="$1"
  [[ -z "$target" ]] && return 1
  [[ "$target" == *"/.."* || "$target" == "../"* || "$target" == ".." ]] && return 1
  [[ "$target" == *".claude/worktrees/"* ]] && return 0
  [[ "$target" =~ ^\$\{?(LITE_)?WORKTREE\}?(/.*)?$ ]] && return 0
  # A literal path is acceptable only when it resolves inside this run's own
  # worktree — the one directory the engine has told us this run owns.
  [[ -n "${LITE_WORKTREE:-}" && "$target" == "$LITE_WORKTREE"* ]] && return 0
  return 1
}

# Split a command string into clauses on `&&`, `||`, `;`, `|`. Naive text
# split (no quote-awareness) — sufficient for the compound delegation idioms
# this guard cares about; none of the legitimate or forbidden forms embed
# these operators inside quoted path segments.
_split_clauses() {
  printf '%s\n' "$1" | sed -E 's/\|\||&&|;|\|/\n/g'
}

# The portion of $clause starting at its own `git` command word (word-
# bounded, not a substring match inside another token) through the end of
# the clause. Empty/failure when the clause has no `git` invocation of its
# own — this is what anchors -C/--git-dir extraction to an actual git
# invocation instead of any occurrence anywhere in the command (e.g. an
# argument to `echo`).
_git_segment() {
  local clause="$1"
  [[ "$clause" =~ (^|[^[:alnum:]_-])git([[:space:]].*)?$ ]] || return 1
  printf '%s' "${BASH_REMATCH[2]}"
}

# Whether $clause carries its OWN -C/--git-dir delegation, scoped to that
# clause's own git invocation. Does not consider cd or other clauses.
_clause_has_own_delegation() {
  local clause="$1" segment target
  segment="$(_git_segment "$clause")" || return 1

  target="$(_flag_target "$segment" '-C[[:space:]]+')"
  _is_worktree_delegation_target "$target" && return 0

  target="$(_flag_target "$segment" '--git-dir=')"
  _is_worktree_delegation_target "$target" && return 0

  return 1
}

# S2 finding 2 (round 2): delegation must be scoped to the forbidden clause
# itself, not merely present anywhere in the full command string — otherwise
# a bare forbidden clause can ride along on an unrelated delegated (or even
# non-git) token elsewhere in the same command (e.g. `git checkout main &&
# git -C <worktree> status`, or `git checkout main; echo -C <worktree>`).
#
# Fix-cycle round 3: `cd <target>` persists for the rest of the shell
# invocation, so it legitimately delegates every LATER clause — but only
# until a SUBSEQUENT `cd` changes the ambient directory again. A leading
# `cd "$WORKTREE" && ...` therefore covers a later forbidden clause, but
# `cd "$WORKTREE"; cd /repo && git checkout main` must not: the second `cd`
# re-targets the shell outside the worktree before the forbidden command
# runs. `ambient_ok` tracks the most recent `cd` clause's validity as the
# loop walks clauses in order; a forbidden clause is allowed iff
# `ambient_ok` is currently true OR it carries its own -C/--git-dir
# delegation (`_clause_has_own_delegation`). Non-cd, non-forbidden clauses
# (e.g. `git status`) leave `ambient_ok` untouched.
#
# Fix-cycle round 4: a `cd` inside a `( ... )` subshell does NOT persist to
# the parent shell (standard bash semantics) — `( cd "$WORKTREE" ) && git
# checkout main` must stay BLOCKED even though the cd's own target is valid,
# because by the time `git checkout` runs the parent shell's cwd was never
# changed. Model: each unmatched `(` opens a nested ambient-scope and each
# `)` closes it, tracked with an explicit stack (`ambient_stack`). Per
# clause, in order: (1) for every `(` in the clause, push the CURRENT
# `ambient_ok` (the outer scope's value) before evaluating the clause's own
# cd/forbidden logic, so a `cd` inside the new scope only mutates the
# nested copy; (2) evaluate the clause's own cd-target or forbidden-command
# logic as before; (3) for every `)` in the clause, pop the stack and
# restore `ambient_ok` to exactly what it was immediately before the
# matching `(` — this is what stops a subshell-scoped cd from leaking
# outward once its subshell closes. A forbidden clause is evaluated against
# whatever `ambient_ok` is in effect after step (1) for its own clause,
# which correctly reflects nesting depth at that point in the sequence.
# Clauses with no parens are a no-op push/pop (depth 0 throughout), so the
# plain persistent-`cd` idiom and per-clause `-C`/`--git-dir` delegation are
# unaffected.
_count_char() {
  local s="$1" c="$2" stripped
  stripped="$(printf '%s' "$s" | tr -cd "$c")"
  printf '%s' "${#stripped}"
}

has_valid_delegation() {
  local cmd="$1" clause cd_target ambient_ok=false
  local -a ambient_stack=()
  local opens closes i

  while IFS= read -r clause; do
    opens="$(_count_char "$clause" '(')"
    closes="$(_count_char "$clause" ')')"

    for ((i = 0; i < opens; i++)); do
      ambient_stack+=("$ambient_ok")
    done

    if [[ "$clause" =~ ^[[:space:]]*\(?[[:space:]]*cd[[:space:]] ]]; then
      cd_target="$(cd_delegation_target "$clause")"
      if _is_worktree_delegation_target "$cd_target"; then
        ambient_ok=true
      else
        ambient_ok=false
      fi
    elif is_forbidden_command "$clause"; then
      if [[ "$ambient_ok" != true ]] && ! _clause_has_own_delegation "$clause"; then
        return 1
      fi
    fi

    for ((i = 0; i < closes; i++)); do
      if [[ ${#ambient_stack[@]} -gt 0 ]]; then
        ambient_ok="${ambient_stack[-1]}"
        unset 'ambient_stack[-1]'
      fi
    done
  done < <(_split_clauses "$cmd")

  return 0
}

if has_forbidden_push "$COMMAND"; then
  printf 'BLOCKED: a run does not move a shared ref.\n' >&2
  printf 'The command:\n  %s\n' "$COMMAND" >&2
  printf 'pushes to a protected destination, forces, or leaves the destination unstated.\n' >&2
  printf 'This layer produces a verified change candidate; merging and releasing it belong\n' >&2
  printf 'to whatever takes it from here. Push the run own branch by name instead.\n' >&2
  exit 2
fi

is_forbidden_command "$COMMAND" || exit 0
has_valid_delegation "$COMMAND" && exit 0

printf 'BLOCKED: REPO_ROOT HEAD must stay on `main` (Iron Law 4).\n' >&2
printf 'The command:\n  %s\n' "$COMMAND" >&2
printf 'is HEAD-mutating without valid worktree delegation.\n' >&2
printf 'Delegate via: `cd "$WORKTREE" && ...`, `git -C "$WORKTREE" ...`, or `git --git-dir=...`.\n' >&2
exit 2
