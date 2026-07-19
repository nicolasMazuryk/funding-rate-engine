# Agent Workflow

> How Claude Code should operate when working on tasks.

---

## Workflow Orchestration

### 1. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 2. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 3. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, run commands, check logs, verify in runtime, demonstrate correctness

### 4. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 5. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Zero context switching required from the user

---

## Verification Gate (task 0180)

- **`npm run verify` before every commit.** Non-negotiable — see root `CLAUDE.md`
  "Commands" and `docs/testing-strategy.md`. Use the `verify` skill
  (`.claude/skills/verify/`) to run and interpret it.
- **Post-edit hook.** `.claude/settings.json` runs `.claude/hooks/post-edit-check.mjs`
  after every `Edit`/`Write`/`MultiEdit` — scoped `biome check` on the touched file plus
  a full `tsc --noEmit` (fast at this codebase's size). This is a fast per-edit signal,
  not a substitute for `npm run verify`: it never runs the test suite, so a green hook
  does not mean the repo is done — still run `verify` before committing.
- **Debugging without a live venue:** use the `replay` skill to diff a recorded trace
  against the current core, and the `scenario` skill to run one sim fault scenario in
  isolation. Neither needs credentials.

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.