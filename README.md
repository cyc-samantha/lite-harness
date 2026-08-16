# lite-harness

An execution layer. A sealed work contract goes in; a **verified change
candidate** comes out — a branch, evidence for every acceptance criterion, and a
record of the world it was produced in.

It does not decide whether the work is done. It produces evidence, and the work
source adjudicates that against criteria a person sealed. That division is the
whole design: **the thing doing the work never grades it.**

It also stops there. Merging the branch, running CI on it, releasing it, watching
it in production — all of that is the next system's. Drawing the line here is
deliberate: a delivery layer whose definition of done reaches into production
acquires a merge queue, a release process and an incident channel, and stops
being something a small change can pass through ten times a day.

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
| `LITE_SOURCE_URL` | Base URL of the work source | `http://127.0.0.1:4600` |
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
| 1 | `start <contract-id>` | Claims the work, runs the admission checks, fixes the execution basis, prepares the worktree |
| 2 | `prompt <runId>:implementer` | The change itself, inside the worktree |
| 3 | `gates <runId>` | Which rung went red, and what class of failure that is |
| 4 | `scope <runId>` | Whether the change left the contract's boundary |
| 5 | `prompt <runId>:reviewer` | A second reading, against the contract and nothing else |
| 6 | `pr <runId> <url>` → `report <runId>` | Records the candidate and forwards the audit trail |
| 7 | `submit <runId>` | Evidence to the work source, which returns the verdict |

Steps 1, 3, 4 and 7 are decisions a machine can be held to. The rest are
judgements. Nothing in the first group asks a model, and nothing in the second
returns a verdict.

A failure exits with its class — `2` retryable, `3` hard stop, `4` spec blocked,
`5` waiting on a named person — and prints where it stopped and who acts next.
Those are four different people, and a system that answers only "it failed" sends
all four to the same place.

## Layout

| Directory | Contains | Rule |
|---|---|---|
| `ports/` | The two interfaces the engine depends on | No implementation |
| `adapters/` | One work source's wire format and quirks | The only place upstream types appear |
| `engine/` | Admission, gates, evidence, scope, prompts, run record | Names no project, imports no adapter |
| `bin/` | The composition root | The only file that knows both sides |
| `roles/` | The role prompts | No repository facts |
| `hooks/` | Five guards | Path-based, never role-based |
| `skills/run/` | The orchestrator's sequence | Coordinates; writes nothing |
| `rules/core.md` | What every spawn is told | Under budget, or the build fails |

## The admission checks

Nothing reaches an agent until all of them pass. They read contract shape and
declared capability — never source — so they are identical for every project and
cost no model call at all.

Contract shape · seal integrity · authority · dependencies · unaccepted proposal ·
unanswered decision · missing signature · unevidenceable criterion · capability
match · scope resolvable · protected-path conflict · environment ready · secret
unavailable.

Three of those read the seal for what it fails to say. A criterion still marked
`proposed` is not yet anyone's requirement. A blocking decision the seal records
no answer to is one this layer cannot confirm anybody answered — and an agent
handed an unanswered decision does not stop, it picks an answer and that answer
becomes policy. Work marked `rewrite` or `critical` needs a signature the seal
actually carries.

All three refuse on absence, which will over-refuse against a work source that
records its answers elsewhere. That is the intended direction: an answer kept
outside the seal was never sealed, and the fix is to seal it.

Each refuses on input it cannot evaluate. A reference that will not resolve, a
dependency the source has never heard of, a gate whose command is missing: all
stop the run rather than proceeding on the assumption it was probably fine.

## What a run records about the world it ran in

A sealed contract says what was approved. It does not say what the work was
approved *against* — and the same contract, run in March and again in May, can
pass and then fail without a byte of it changing. The base branch moved. The
gate commands were edited. The engine was upgraded.

So every run fixes an **execution basis** at admission and stamps it on every
checkpoint and every piece of evidence:

| Field | Why it is not derivable from the others |
|---|---|
| `contract_sha` | which sealed version, of possibly several |
| `base_repo_sha` | `main` in March and `main` in May are the same name, not the same commit |
| `project_config_sha` | the gates are declared in a file that changes |
| `harness_version` | the engine changes |
| `execution_protocol_version` | whether a later engine can still honour this run at all |
| `contract_schema_version` | what shape was accepted when it was admitted |

None of this can be backfilled. The worlds are gone by the time anybody asks.

## What a run may reach

Path scope is not execution scope. An agent that stays entirely inside one
permitted file — clean diff, no scope violation, every gate green — can still
call an external API, drop a table, rotate a credential, or move money. The
filesystem boundary does not touch any of that.

`permissions` in `project.yaml` is therefore required, and everything in it
defaults to denied: network egress, database read and write, named secrets,
infrastructure mutation, production access. `permissions: {}` is a repository
saying it grants nothing; no key at all is a repository that never considered the
question, and that is refused.

`secrets` is enforced, and it is the only entry here that is enforced by
subtraction rather than by inspection. A command the engine spawns receives a
fixed base — enough to find a binary and a home directory — plus what
`env.vars` declares and exactly the names `secrets` grants. Nothing else is
passed. A credential absent from an environment is unreachable by any spelling
of any command, which is why this is the one control in this section that
cannot be talked around; a granted name the machine does not export refuses at
admission rather than surfacing later as an auth error inside a test run.

**The rest is a declaration, not an enforcement.** Network egress, database
access, infrastructure mutation and production access are recorded and not
prevented. Making them real needs a sandbox — network namespaces, a credential
broker, an isolated database — and that is a slice of its own. The shape is
here first because a declaration nobody wrote cannot be added afterwards: it
would mean asking, a year from now, what every past run had been permitted to
do.

In practice the subtraction already reaches further than its own row: dropping
a table, destroying a volume and deploying to production all need a credential,
so a run that was never handed one fails at those without any rule having to
recognise them.

## The gate ladder

Declared by the target repository, in declared order, stopping at the first red.
Order is the cost model. A `record_only` rung measures without blocking — a
threshold nobody has data for is a guess, and a gate that fails on a guess gets
routed around until it means nothing.

The rung that matters most runs the test the contract named for each criterion.
Its exit code becomes that criterion's evidence, which is what takes the verdict
out of the model's hands.

## The guards

Five hooks, all keyed on paths rather than on which role is acting — a guard that
asks who is calling can be talked out of its answer.

They are **run-scoped**: enforcement begins when the engine exports
`LITE_WORKTREE` and is dormant otherwise, because a guard that blocks ordinary
interactive git in every project it is installed in gets uninstalled. Once a run
is in flight, every undecidable case blocks.

Two of them draw the same boundary at two surfaces: `worktree-boundary.sh` for
Write and Edit, `bash-boundary.sh` for the shell. Both refuse a target they
cannot resolve, which is what catches the accident neither a rule nor a model
catches — `rm -rf "$BUILD_DIR"/` with the variable unset is `rm -rf /`, and at
that moment nothing in anyone's reasoning has gone wrong.

`main-branch-guard.sh` carries two rules that look alike and are not. A HEAD
mutation is excused by worktree delegation, because a worktree HEAD is the run's
own to move. Moving a **shared** ref is excused by nothing: `git -C "$WORKTREE"
push origin main` is exactly as wrong as the bare form, so push is decided
before the delegation logic and never reaches it.

**What the shell guard is not.** It reads a command string, and capability
belongs to the process that string starts — `node ./fix.js` is a legal
in-worktree write followed by a program free to write anywhere. It is a net for
the common accident, in the sense `secret-guard.sh` means it, and its detection
is knowingly incomplete even though its decision is closed. The boundary that
does not depend on recognising anything is the environment a run is spawned
with, above.

`LITE_GUARDS=off` disables all of them. It exists for debugging the harness
itself; the orchestrator must never export it, and a run that needed it was
telling you something.

## Prompts are assembled, never written

Four slots, stablest first, because a cache reuses a prefix and stops at the
first byte that differs: **project → contract → role → payload**. Putting the
role first is the obvious arrangement and breaks the prefix at position one, so
two roles in the same run share nothing.

Slot 1 carries the target repository's `AGENTS.md` alongside its gate
declarations — one document per repository, identical across every call ever
made against it, so the cache holds it once. Sending a model to read the
repository and pick files instead is paying tokens to rebuild what that file
states directly, which is why the context-packer step is now optional and off by
default. It earns its place once somebody measures implementers wasting turns
hunting for files, and not before.

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
npm run check      # typecheck + 172 unit tests
bats tests/shell/  # 99 hook tests
```

`.ts` files run directly under Node's type stripping — no build step. Conventions
for working on this repository are in `CLAUDE.md`.

## Status

Slices 1 and 2 are done: one contract, one run, claim to `accepted`; failures
classified, retries bounded, and a run that cannot finish hands the work back
with an account of why. A real sealed contract ran against
[harness-factory-map][pilot] and was adjudicated `accepted`, and deliberately bad
contracts were run against the live system to check that they escalate rather
than loop.

That exercise found the worst defect so far: a contract naming a test nobody had
written was **accepted**. Runners that select tests by name exit zero when they
match nothing, so the rung that proves an acceptance criterion proved a criterion
nothing had touched. Evidence now requires the named test to exist as well as the
rung to be green.

Slice 3 is done: evidence binds to the execution basis and not only the contract,
failures answer who acts next in four ways rather than two, the seal is read for
three things it may fail to say, and the two retry layers share one budget.

Same-agent repair stopped being absolute in the same slice. It remains the
default — reloading context is slow, expensive, and loses what was already tried
— but an implementer that misread the architecture repairs from that misreading
and eventually edits the test to match. Two signals now buy one clean restart:
the same error signature twice, and a diff that returns to a shape the run
already produced.

Slice 4 closed the gap between what `permissions` declared and what a run was
actually handed. Every command the engine spawned had inherited the operator's
whole environment, so each gate held every credential that operator held while
`permissions.secrets` sat in the declaration granting none — the declaration
said nothing and the runtime gave everything, and nothing reported the
disagreement. The same slice put a mechanism behind a rule that had none: this
layer's own README says merging and releasing belong to whatever takes the
candidate from here, and a run could force-push to the base branch and pass
every guard in the repository.

**Known gaps, deliberately.** Network egress, database access, infrastructure
mutation and production access are declared and not enforced, and wait on a real
sandbox; what limits them today is that a run holds no credential to reach them
with. The shell guard reads command strings, so it is a net for accidents and
not a boundary a determined process respects — one indirection through any
interpreter is past it. The shared budget is reconciled locally, so a contract retried on a
second machine refuses rather than proceeding — correct, but it refuses a case
that should work. Concurrency is one claim per contract and nothing more: no
merge queue, because text-level non-overlap is not semantic non-overlap and what
makes parallel runs safe is serialising the merge point, not declaring scopes.
No second target repository yet, so "onboarding costs no engine change" is still
a claim rather than a demonstration.

[pilot]: https://github.com/cyc-samantha/harness-factory-map/pull/2
