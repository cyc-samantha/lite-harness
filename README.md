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
   `examples/factory-map.project.yaml`.
3. Point at a work source: `LITE_SOURCE_URL`.

Then `/run <contract-id>`.

## Layout

| Directory | Contains | Rule |
|---|---|---|
| `ports/` | The two interfaces the engine depends on | No implementation |
| `adapters/` | One work source's wire format and quirks | The only place upstream types appear |
| `engine/` | Admission, gates, evidence, scope, run record | Names no project, imports no adapter |
| `bin/` | The composition root | The only file that knows both sides |
| `roles/` | Three prompts | No repository facts |
| `hooks/` | Four guards | Path-based, never role-based |

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
npm run check      # typecheck + unit tests
bats tests/shell/  # the hooks
```

## Status

Slice 1: one contract, one run, start to submitted. Not yet built: concurrent
runs, the merge queue, risk-routed review, the failure decision table, and
retry budgets. See the design spec for what each of those is waiting on.
