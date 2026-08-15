---
name: run
description: Execute one sealed work contract end to end — claim it, admit it, implement it in an isolated worktree, run the target repository's gates, and submit evidence. Use when the user names a contract id to run, or asks to pick up work from the board.
---

# Run a contract

You are the orchestrator. You **coordinate**; you do not write the code, and you
do not decide whether the work passed. The engine makes every verdict that a
machine can be held to; you make the judgements it cannot.

Read `rules/core.md` before anything else. It is short on purpose.

## Environment

| Variable | Meaning |
|---|---|
| `LITE_TARGET` | Path to the target repository (contains `.harness/project.yaml`) |
| `LITE_SOURCE_URL` | Base URL of the work source |
| `LITE_DATA` | Where run state and worktrees live |
| `LITE_MODEL_ID` | Which model is driving this run. The engine cannot observe it, so an unset value is recorded as `unreported` rather than guessed |
| `LITE_MAX_GATE_RUNS` | Rungs one run may execute before it halts (default 30) |
| `LITE_MAX_WALL_MINUTES` | Minutes one run may take before it halts (default 90) |

The two limits count what the engine can see. Tokens and money are what you would
rather cap, but the engine only ever observes commands and a clock, and a ceiling
enforced on a number a model reports about itself is not a ceiling.

## The lease

Every subcommand renews the run's lease before doing anything, and refuses if the
renewal is refused. A refusal is not a transient error to retry around: it means
the work source already requeued this contract and somebody else may hold it.
Stop and report it.

Implementing and reviewing happen inside a subagent, where no subcommand is
running and so nothing is renewing. **Call `node bin/lite.ts beat <runId>` every
few minutes during those two stretches.** The lease is shorter than a long
implement phase, which is exactly when losing it costs the most.

## The sequence

### 1. Start

```bash
node bin/lite.ts start <contract-id>
```

This claims the work, runs the eight admission checks, and prepares a worktree.
It prints `runId`, `worktree`, and `branch`.

**If it refuses, stop.** Report the named check and its reason verbatim. Do not
try to work around it, do not re-run hoping for a different answer, and do not
"fix" the contract — a refusal here means the work was not ready, and that is a
finding for a person, not an obstacle for you.

Then export, so the guards and the audit log know which run is in flight:

```bash
export LITE_WORKTREE=<worktree> LITE_RUN_ID=<runId> LITE_RUN_DIR="$LITE_DATA/run/<runId>"
```

### 2. Pack the context

**Never write a prompt yourself.** Ask for it:

```bash
node bin/lite.ts prompt <runId>:context-packer
```

Spawn a subagent with exactly that text. Keeping the slots in order is what lets
the cache reuse them across every spawn in this run, and keeping each role's
input to what its own payload allows is what stops the reviewer being told things
it must not know. Composing your own prompt loses both.

Store what the packer returns:

```bash
node bin/lite.ts pack <runId> <<'PACK'
<the packer's file list>
PACK
```

Do not read the repository yourself. Keeping that exploration out of your context
is the point of the role.

### 3. Implement

```bash
node bin/lite.ts prompt <runId>:implementer
```

Spawn a subagent with that text. It works only inside the worktree — a hook
enforces this, so a blocked write is the system working, not a problem to route
around.

### 4. Gates

```bash
node bin/lite.ts gates <runId>
```

The exit code tells you what kind of failure it was, and the printed decision
tells you why:

| Exit | Meaning |
|---|---|
| 0 | every rung passed |
| 2 | retryable — fix it and run gates again |
| 3 | **do not retry.** The table has already decided this cannot be fixed by trying again |

On exit 2, hand the printed output **back to the same implementer subagent** and
let it fix the problem in place. Do not spawn a fresh implementer — the context
that produced the code is the context that should repair it. If you must
re-spawn, ask for the prompt again: it now carries the failure, and its shared
prefix is unchanged, so the cache still holds.

On exit 3, stop. The run has hit a broken seal, a spent budget, a missing tool, a
gate that has had its three attempts, or a failure identical to the last one.
None of those get better on a fourth try. Ask for a judgement:

```bash
node bin/lite.ts prompt <runId>:escalation-judge
```

The judge answers `retry`, `escalate`, or `amend`. Then send the packet:

```bash
node bin/lite.ts escalate <runId> <<'EOF'
<what was seen, what was tried, what should happen>
EOF
```

Add `amend` as a second argument when the contract itself is the problem:
`escalate <runId> amend`. That is the road most often missed — a run that finds
the sealed contract contradictory should say so, not quietly build something
else and not silently give up.

Both forms hand the work back to its source. Neither is a failure of yours.

### 5. Scope

```bash
node bin/lite.ts scope <runId>
```

Exit 2 means the change left the contract's boundary. Do not widen the scope —
you cannot amend a sealed contract. Either have the implementer bring the change
back inside, or escalate.

### 6. Review

```bash
node bin/lite.ts prompt <runId>:reviewer
```

The diff is computed for you, and the reviewer's payload has nowhere to put a
context pack, a repository path, or the history of the fixes. That is not a rule
you have to remember — it is why you must not assemble this prompt by hand.
Withholding those is what makes the second reading independent.

Findings go back to the implementer. When the reviewer says the diff is sound,
continue.

### 7. Open the pull request

Commit inside the worktree, push the branch, and open a pull request against the
base named in `project.yaml`. The description must contain:

- each acceptance criterion and the test that proves it
- the gate results
- **what you did not do**, and why

Then record it, so a supervisor sees it without reading this session:

```bash
node bin/lite.ts pr <runId> <url>
node bin/lite.ts report <runId>
```

`pr` refuses a second call. If it does, a pull request already exists for this
run — find it rather than opening another.

### 8. Submit

```bash
node bin/lite.ts submit <runId>
```

The verdict comes back `accepted`, `awaiting_human`, or `rejected`. Report it as
it is. `awaiting_human` is the normal outcome for a contract with criteria a
person owns — it is not a failure, and the pull request is where that person
looks.

## When you are tempted

- To re-plan because the contract seems wrong → **stop and say so.** Amending a
  sealed contract without saying so is the worst available outcome.
- To weaken a test to get a gate green → never.
- To report success without a fresh gate run → never. The exit codes are the
  claim; your account of the work is not.
