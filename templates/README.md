# Templates

Two templates, two different persistence lifetimes. Getting this backwards
breaks the resume flow in `PLAN.md` §5, so it's spelled out once here
instead of only in comments.

| File | Lives at | Git-tracked? | Lifetime |
|---|---|---|---|
| `STATE.md.tmpl` → `STATE.md` | `$CLAUDE_PLUGIN_DATA/runs/<slug>/STATE.md` | No | Ephemeral, per-machine. Survives a session dying but not a `git clone` elsewhere. |
| `plan.md.tmpl` → `plan.md` | `<worktree>/plan.md`, committed to branch `lite/<slug>` | Yes | Durable. Travels with the branch — recreating the worktree from `branch` (PLAN.md §5 Resume flow step 4) recovers it for free. |

## Why the split

- **`STATE.md`** is orchestration bookkeeping: which phase the run is in,
  how many review loops have fired, which task is in progress, and a
  decisions log. It's read/written by the orchestrator and stamped by
  `hooks/state-checkpoint.sh` on every Stop/SubagentStop. None of this
  needs to be — or should be — part of the project's own git history; it's
  about the *run*, not the *code*. Keeping it out of git also means it
  never shows up in the eventual PR diff.
- **`plan.md`** is a deliverable: the task breakdown, ACs, and test
  strategy that software-engineer and qa-engineer build against. PLAN.md
  §2 is explicit that it "is committed to the worktree branch, not just
  kept in context" — if a session dies mid-build, the branch (and
  therefore `plan.md`) is the one thing guaranteed to still exist even if
  `$CLAUDE_PLUGIN_DATA` was wiped or the run happens on a different
  machine.

## Resume, concretely

`/lite:resume [slug]` (PLAN.md §5 Resume flow) reads **both**:
1. `STATE.md` for `phase`, `review_loops`, and the task checkbox list —
   "where was I, and what's left."
2. `plan.md` (via `git -C <worktree> show <branch>:plan.md` or a plain
   read if the worktree still exists) — "what am I building, and what are
   the ACs" — re-supplied to whichever agent gets re-spawned for the
   recorded phase.

If the worktree is gone, only `plan.md` (recovered from `branch`) is
guaranteed; `STATE.md` is reconstructed by re-deriving progress from
`git log --oneline` on that branch plus whatever `STATE.md` survived on
disk. Never invert this — do not put task-breakdown content in `STATE.md`
only, and do not put phase/loop-count bookkeeping in `plan.md`.
