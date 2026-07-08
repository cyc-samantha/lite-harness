# lite-harness

Lightweight Claude Code plugin: `/lite:build` runs a defined idea through Plan → Build (TDD) → Test → Review → PR — good-practice code quality, prototype-grade ceremony.

**Status: scaffold only.** This repo currently contains the spec (`PLAN.md`) and the pickup-ready task list (`TASKS.md`). No agents, skills, or hooks are implemented yet — the directories exist as placeholders for the work described in `TASKS.md`.

See `PLAN.md` for the full design (pipeline, agent roster, Iron Law enforcement mapping, memory/resume model, install/usage). See `TASKS.md` for the L1–L8 implementation order.

This harness is a companion to, not a replacement for, the full production harness. It intentionally omits intake fingerprinting, Best-of-N/PDR-RTV build variants, the Final Gate quartet, deploy, and the continuous-learning loop — see `PLAN.md` §2 for what was cut and why.
