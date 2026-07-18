# EXECUTION — Standard Operating Procedure for Task Agents

This is the fixed procedure a Claude Code agent follows for **every** task in `docs/plan/tasks/`. It does not change per task. Task status lives in `docs/plan/STATUS.md` — never here.

## Prerequisites (once per session)

You have zero memory of previous sessions. Ground yourself:

1. Read `docs/plan/ROADMAP.md` — at minimum: the phase overview (§1), the binding decisions & assumptions (§3). Use `docs/plan/COVERAGE.md` to see which task owns a given spec section.
2. Read `docs/plan/STATUS.md` — confirm every task listed before your task ID is `done`. If any task before your task ID is not `done`, stop and report; do not start.
3. Read the root `CLAUDE.md` (and any nested `CLAUDE.md` in directories you will touch).

## Per-task procedure

1. **Claim.** Set your task's row in `STATUS.md` to `in_progress` (add your session date in notes).
2. **Read the task file** (`docs/plan/tasks/NNNN_*.md`) completely.
3. **Read every spec section listed in the task's "Spec references"** — the task file states scope; the specs are the source of truth for detail. Do not implement from the task file's summary alone.
4. **Survey the repo state** relevant to your scope (the task's "Context for the agent" tells you where things live).
5. **Implement**, following `docs/agent-workflow.md` (test-first where practical) and the task's Scope — **In scope** fully, **Out of scope** not at all. If you discover a blocker or a spec contradiction not covered by ROADMAP §3, make the smallest reasonable decision, implement it, and record it in STATUS notes — do not stall, do not silently expand scope.
6. **Verify** by running the task's "Verification (definition of done)" steps exactly, plus `npm run verify`. Every step must pass. All **pre-existing** checks must still pass — a task never leaves the repo red.
7. **Self-review** against `docs/architecture.md` rules (purity boundary, WAL-before-side-effect, fail-loud, KISS, DRY, "the less code - the better") and the task sizing intent (no scope creep into later tasks).
8. **Update the ledger.** Set the task to `done` in `STATUS.md`; note anything the next agent must know (assumption made, substitution recorded, follow-up needed).
9. **Commit** with a conventional message referencing the task ID, e.g.:
   `feat(core): event bus, ports, purity lint [task 0030]`
   `test(binance): testnet tier suite [task 0260]`
   One task = one commit (or a small series, each referencing the task ID). Never mix tasks in a commit.

## Rules

- **Green in, green out.** If the repo is red when you arrive, that is a blocker for the offending task — record it in STATUS and fix-or-report before proceeding.
- **No forward dependencies.** If your task seems to need something from a higher-numbered task, you have misread scope — re-read the task file's Out-of-scope list; if genuinely blocked, record it in STATUS notes and stop.
- **Specs win.** Where a task file and a spec disagree on behavior detail, the spec wins (and ROADMAP §3 assumptions win over ambiguous specs). Record any such conflict you resolve.
- **Verification is mechanical.** "Looks right" is not done. Only the task's numbered verification steps, passing, make it done.
- **Live tiers:** tasks 0470–0500 touch real money. Never raise caps, never bypass the harness wrapper, never automate live runs outside the documented commands.

## Status ledger

The ledger is `docs/plan/STATUS.md`: one row per task — `ID | status | notes`. Statuses: `todo` → `in_progress` → `done` (plus `blocked` with a reason in notes). Agents edit only that file to report progress.
