# 0020 — Agent context layer: CLAUDE.md, `.claude/`, working docs

**Phase:** 0 — Foundation
**Depends on:** 0010
**Spec references:** `0000_agentic-development-environment.md` §2 (Agent context layer), §7 (Working documentation); `08_system_overview.md` §2 (Engineering principles), §3 (Layers)

## Objective
The root project memory and Claude Code configuration that let a fresh agent operate this repo effectively: root `CLAUDE.md`, `.claude/settings.json`, and the two working docs (`docs/architecture.md`, `docs/agent-workflow.md`) that encode the layer rules and the task loop. After this task, every subsequent agent session starts with correct context instead of re-deriving it.

## Context for the agent
Task workflow for this repo: agents pick tasks from `docs/plan/tasks/`, follow `docs/plan/EXECUTION.md`, update `docs/plan/STATUS.md`. The architecture is ports-and-adapters with a pure core (`08` §3): core imports no I/O libraries. `npm run verify` (from 0010) is the universal gate. Nested CLAUDE.md files for `src/core/`, `src/adapters/`, `test/` are **not** in this task — they land JIT with tasks 0030, 0190, 0160.

## Scope
- In scope:
  - Root `CLAUDE.md`: project one-liner, spec navigation map (which spec answers what — mirror `08` §1 doc map), the command list (`npm run verify` and sub-commands), architecture rules in brief (purity boundary, WAL-before-side-effect, fail-loud), conventions (conventional commits referencing task IDs, unit conventions percent-vs-fraction from `00_globals` §1.2), and the task workflow pointing at `docs/plan/EXECUTION.md`.
  - `.claude/settings.json`: permissions allowing the standard loop (npm scripts, tests, git) per current Claude Code settings schema.
  - `docs/architecture.md`: the layer diagram and dependency rule from `08` §3, the event-stream spine (`08` §4), pattern inventory (`08` §5), and **why**, each mapped to its enforcement (lint boundary from 0030, code review rules).
  - `docs/agent-workflow.md`: the loop — read spec → plan → write failing test → implement → `npm run verify` → self-review vs architecture rules → commit conventionally.
- Out of scope: nested CLAUDE.md files (0030/0160/0190), hooks/skills/commands/subagents (0180), `docs/testing-strategy.md` (0180).

## Implementation notes
Keep CLAUDE.md short and imperative — it is loaded into every session; link to `docs/architecture.md` for depth rather than duplicating. Do not document commands that do not exist yet; add them in the tasks that create them (this is why hooks/skills are deferred to 0180).

## Verification (definition of done)
1. `npm run verify` — still green.
2. Files exist: `CLAUDE.md`, `.claude/settings.json`, `docs/architecture.md`, `docs/agent-workflow.md`.
3. `.claude/settings.json` parses as JSON (`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`).
4. Every command named in CLAUDE.md exists in `package.json` scripts (check by grep).
