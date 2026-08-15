# lite-harness

An execution layer. A sealed work contract goes in; a branch with evidence for
every acceptance criterion comes out.

It does not decide whether the work is done. It produces evidence, and the work
source adjudicates that against criteria a person sealed. That division is the
whole design: **the thing doing the work never grades it.**

## What it is not

Not a planner — the plan was made and sealed upstream, and re-planning during
execution amends a contract without saying so. Not a ticket system. Not a
reviewer of its own output. Not tied to any one codebase or any one place work
comes from.

## Onboarding a project: three steps

If this ever takes four, something project-specific has leaked into the engine.

1. Install this plugin.
2. Add `.harness/project.yaml` to the target repository — see
   `examples/factory-map.project.yaml`. It lives there, not here, so it is
   reviewed and rolled back alongside the code it describes.
3. Set the environment below.

Then `/run <contract-id>`.

| Variable | Meaning | Default |
|---|---|---|
| `LITE_TARGET` | The repository being worked on | the current directory |
| `LITE_SOURCE_URL` | Base URL of the work source | `http://127.0.0.1:8787` |
| `LITE_DATA` | Where run state and worktrees live | `~/.claude/lite` |
| `LITE_AGENT` | Name recorded on the claim | `lite-harness` |

`LITE_TARGET` defaults to the current directory, which is almost never what you
want — unset, a run claims work and then looks for gates in whatever repository
you happened to be standing in.

## A run, end to end

`skills/run/SKILL.md` is the orchestrator's copy of this. Each subcommand is safe
to run twice: a run is resumed, not restarted.

| | Command | What it decides |
|---|---|---|
| 1 | `start <contract-id>` | Claims the work, runs the eight admission checks, prepares the worktree |
| 2 | `prompt <runId>:context-packer` → `pack <runId>` | Which files matter, stored for the implementer |
| 3 | `prompt <runId>:implementer` | The change itself, inside the worktree |
| 4 | `gates <runId>` | Exit 2 means a rung went red; the output goes back to the same implementer |
| 5 | `scope <runId>` | Exit 2 means the change left the contract's boundary |
| 6 | `prompt <runId>:reviewer` | A second reading, against the contract and nothing else |
| 7 | `report <runId>` | Forwards the audit trail upstream |
| 8 | `submit <runId>` | Evidence to the work source, which returns the verdict |

Steps 1, 4, 5 and 8 are decisions a machine can be held to. The rest are
judgements. Nothing in the first group asks a model, and nothing in the second
returns a verdict.

## Layout

| Directory | Contains | Rule |
|---|---|---|
| `ports/` | The two interfaces the engine depends on | No implementation |
| `adapters/` | One work source's wire format and quirks | The only place upstream types appear |
| `engine/` | Admission, gates, evidence, scope, prompts, run record | Names no project, imports no adapter |
| `bin/` | The composition root | The only file that knows both sides |
| `roles/` | Three prompts | No repository facts |
| `hooks/` | Four guards | Path-based, never role-based |
| `skills/run/` | The orchestrator's sequence | Coordinates; writes nothing |
| `rules/core.md` | What every spawn is told | Under budget, or the build fails |

## The eight admission checks

Nothing reaches an agent until all of them pass. They read contract shape and
declared capability — never source — so they are identical for every project and
cost no model call at all.

Contract shape · seal integrity · authority · dependencies · capability match ·
scope resolvable · protected-path conflict · environment ready.

Each refuses on input it cannot evaluate. A reference that will not resolve, a
dependency the source has never heard of, a gate whose command is missing: all
stop the run rather than proceeding on the assumption it was probably fine.

## The gate ladder

Declared by the target repository, in declared order, stopping at the first red.
Order is the cost model. A `record_only` rung measures without blocking — a
threshold nobody has data for is a guess, and a gate that fails on a guess gets
routed around until it means nothing.

The rung that matters most runs the test the contract named for each criterion.
Its exit code becomes that criterion's evidence, which is what takes the verdict
out of the model's hands.

## The guards

Four hooks, all keyed on paths rather than on which role is acting — a guard that
asks who is calling can be talked out of its answer.

They are **run-scoped**: enforcement begins when the engine exports
`LITE_WORKTREE` and is dormant otherwise, because a guard that blocks ordinary
interactive git in every project it is installed in gets uninstalled. Once a run
is in flight, every undecidable case blocks.

`LITE_GUARDS=off` disables all of them. It exists for debugging the harness
itself; the orchestrator must never export it, and a run that needed it was
telling you something.

## Prompts are assembled, never written

Four slots, stablest first, because a cache reuses a prefix and stops at the
first byte that differs: **project → contract → role → payload**. Putting the
role first is the obvious arrangement and breaks the prefix at position one, so
two roles in the same run share nothing.

The payload type is the other half. A reviewer's payload carries a diff and has
no field for the context pack, the repository, or how the implementation went —
so its second reading stays independent by construction rather than by anyone
remembering. `bin/lite.ts prompt <runId>:<role>` is the only supported way to
build one.

## Staying light

Three tests do the work that discipline otherwise has to:

- `engine-purity` — the engine imports no adapter, names no project, hardcodes no
  host. Every pressure on a harness pushes toward one small project-specific
  branch in the engine; a year of that and no new project can be added.
- `token-budget` — always-loaded rules and role prompts stay under their limits.
  Prompt text is paid for on every spawn forever, and it crowds out the rules
  that actually constrain the work.
- `schema-conformance` — the two formats crossing the boundary still parse.

A budget nobody can fail is a wish. These fail the build.

## Development

```bash
npm run check      # typecheck + 56 unit tests
bats tests/shell/  # 58 hook tests
```

`.ts` files run directly under Node's type stripping — no build step. Conventions
for working on this repository are in `CLAUDE.md`.

## Status

Slice 1 is done: one contract, one run, claim to `accepted`.

A real sealed contract ran against [harness-factory-map][pilot], produced a pull
request, and was adjudicated `accepted` by the work source. All eight admission
checks passed against a real repository, all six gate rungs ran, and the test
named by the acceptance criterion was confirmed red before the change and green
after — so the evidence stands for something.

The run found four defects that no unit test would have:

- branch names were built from contract ids containing colons, which git refuses
- a retried contract asked for the branch its previous attempt had created
- `git status --porcelain`'s significant leading space was trimmed away, which
  corrupted one path per run and reported it as a scope violation
- a replayed `submit` blamed a lapsed lease instead of saying the work was done

Each is fixed, with tests. The lease itself was validated the hard way: the pilot
outlived its lease mid-run, the work source requeued the contract, and the next
command refused rather than acting on work it no longer held.

Slice 2 is done: failures are classified, retries are bounded, and a run that
cannot finish hands the work back with an account of why.

Deliberately bad contracts were run against the live system. A broken seal and a
scope matching no files are refused at admission. A permanently red gate is
retried once, then recognised as the identical failure and sent to a judge rather
than retried again. A third claim on a twice-failed contract is refused, and so
is any claim whose attempt history cannot be read.

That exercise found the worst defect so far: a contract naming a test nobody had
written was **accepted**. Runners that select tests by name exit zero when they
match nothing, so the rung that proves an acceptance criterion proved a criterion
nothing had touched. Evidence now requires the named test to exist as well as the
rung to be green, and the same contract is rejected.

Not yet built: concurrent runs and the merge queue that would make them safe, and
risk-routed model review.

[pilot]: https://github.com/cyc-samantha/harness-factory-map/pull/2
