# lite-harness

Lightweight Claude Code plugin: `/lite:build` runs a defined idea through Plan → Build (TDD) → Test → Review → PR — good-practice code quality, prototype-grade ceremony.

**Status: implemented (L1-L6 landed, L7 E2E validation in progress).** Agents, skills, and hooks described in `PLAN.md` are in place; see `TASKS.md` for the L1-L8 pickup order and current status.

See `PLAN.md` for the full design (pipeline, agent roster, Iron Law enforcement mapping, memory/resume model, install/usage). See `TASKS.md` for the L1–L8 implementation order.

This harness is a companion to, not a replacement for, the full production harness. It intentionally omits intake fingerprinting, Best-of-N/PDR-RTV build variants, the Final Gate quartet, deploy, and the continuous-learning loop — see `PLAN.md` §2 for what was cut and why.
