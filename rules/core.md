# Core Invariants

Loaded on every spawn. Everything here is something you could not work out from
the code in front of you — a boundary, a convention, or an authority limit. What
good code looks like is not in this file on purpose: you already know, and
spending the always-loaded budget restating it would crowd out the rules that
actually constrain you.

## Boundaries

- **The target repository's default branch is never checked out, reset, or
  committed to.** Every change happens on this run's branch inside this run's
  worktree. Enforced by `hooks/main-branch-guard.sh`.
- **Write only inside this run's worktree.** Enforced by
  `hooks/worktree-boundary.sh`.
- **Stay inside `scope.include`, out of `scope.exclude`.** A change outside the
  boundary fails the run even when it is an improvement — the boundary is what
  lets other runs proceed without colliding.
- **Never add a runtime dependency.** It is a supply-chain decision, and it
  belongs to a person.
- **Never write a secret anywhere**, including into an error message or a log.
- **Staying inside the file boundary is not the whole boundary.** Reaching the
  network, a database, a credential or anything in production is governed by
  `permissions` in the project's declaration, and everything there defaults to
  denied. A clean diff in a permitted file can still do the damage.
- **The shell is inside the boundary too.** A redirect, an `rm`, a `sed -i` is a
  write and is judged like one. A path built from a variable is refused rather
  than guessed at — an unset variable is how a build directory becomes the root.
- **Never move a shared ref.** Push the run's own branch by name. Force-pushing,
  or pushing to the base branch, takes a decision that is not this layer's.

## Where this stops

You produce a **verified change candidate**: a branch, and evidence for every
criterion. Merging it, releasing it and running it are somebody else's. Do not
merge, do not deploy, and do not treat a green ladder as permission to.

## The contract is authoritative

- The plan was made and sealed upstream. **Do not re-plan.** Re-planning inside
  execution is amending the contract without saying so.
- The tests the contract names are the definition of done. **Never weaken a test
  to make it pass.**
- If the contract cannot be satisfied inside its own boundary, **stop and say
  so**. A plausible implementation of the wrong thing costs more than a stop.

## Evidence

- A gate passes when a command exits zero. Nothing else counts, including your
  own account of how the work went.
- **Do not claim completion without fresh output.** Output from earlier in the
  session is not evidence — run it again.

## When a check cannot decide

A gate that hits input it cannot evaluate — a missing file, an unresolvable
reference, an absent command — **refuses**. It never proceeds on the assumption
that the unevaluable thing was probably fine.

## Where things live

| Directory | Rule |
|---|---|
| `ports/` | Interfaces only. No implementation, no imports. |
| `adapters/` | Everything specific to one work source. |
| `engine/` | Knows neither. Never names a project, never imports an adapter. |
| `roles/` | Prompts with no repository facts in them. |
| `hooks/` | Path-based, never role-based. |

A project-specific fact belongs in that project's `.harness/project.yaml`. If it
cannot be said there, extend the schema — do not special-case the project in
`engine/`.
