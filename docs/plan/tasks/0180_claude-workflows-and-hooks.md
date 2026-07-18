# 0180 — Claude workflows: hooks, skills, slash commands, testing-strategy doc

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0020, 0170
**Spec references:** `0000_agentic-development-environment.md` §2 (hooks, skills, slash commands, subagents), §7 (docs/testing-strategy.md); `17_testing.md` §1 (test layers)

## Objective
The Claude Code automation layer, added now — just before the long adapter/strategy grind where it pays off: hooks that gate agent edits with fast checks, reusable skills/commands for the workflows that exist (`verify`, `replay`, scenario-run), subagent definitions where specialization helps, and `docs/testing-strategy.md` describing the tier pyramid and when to add which test.

## Context for the agent
JIT placement is deliberate: commands must wrap workflows that already exist (verify since 0010, replay since 0170, scenarios since 0160). Commands for tiers that don't exist yet (fixture capture, testnet, live) are added by their tasks (0250, 0260, 0470) — leave placeholders out; stale docs are worse than absent ones. Use current Claude Code conventions: `.claude/skills/<name>/SKILL.md` for skills, `.claude/agents/*.md` for subagents, hooks in `.claude/settings.json`.

## Scope
- In scope:
  - Hooks: post-edit typecheck/lint on changed files (fast, scoped — not the full suite per edit), and a pre-commit-style gate documented for the agent loop (`npm run verify` before commit per `docs/agent-workflow.md`).
  - Skills/commands: `/verify` (runs and interprets `npm run verify`), `/replay <trace>` (wraps 0170 incl. `--json` interpretation), `/scenario <name>` (runs one sim scenario and summarizes the trace diff).
  - Subagent definitions where they pay off (e.g. a spec-navigator subagent that answers "which spec section governs X" from `docs/specs/`, and a test-writer profile) — keep to 2–3, justified in each file's description.
  - `docs/testing-strategy.md`: the pyramid (unit → sim scenario → integration/fixture → testnet → live), what each tier proves, what each tier costs, when a task must add which (mirrors `17` §1 + spec 0000 stakes), and pointers to the commands.
  - Update root `CLAUDE.md` command list.
- Out of scope: fixture/testnet/live commands (0250/0260/0470), CI (0530).

## Implementation notes
Hooks must be fast and non-flaky or agents will fight them — scope typecheck to the project references/changed package, keep under a few seconds. Every skill should end by telling the agent how to interpret failure output (structured, per spec 0000 "unambiguous, machine-readable").

## Verification (definition of done)
1. `npm run verify` — green.
2. Hook config in `.claude/settings.json` is valid JSON and references only existing scripts; simulate a hook run by executing its command directly — exits 0 on clean tree.
3. Each skill file names a command that exists in `package.json`; `/replay` skill exercised by running its underlying command on the skeleton golden trace — exit 0.
4. `docs/testing-strategy.md` exists; root `CLAUDE.md` updated (grep for `/verify`, `/replay`).
