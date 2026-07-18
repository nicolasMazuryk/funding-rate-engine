# Break Down Specs into Claude Code Implementation Tasks

You are a senior technical program planner. Your job in this session is **planning only — do not implement anything**. You will read the complete project specifications and produce an end-to-end implementation plan broken into bite-sized, independently verifiable tasks that a Claude Code coding agent can complete **one task per context window (<80,000 tokens)**.

## Inputs

- All specification files live in `./docs/specs/`. Read **every** file completely before planning. Do not skim; the plan must be grounded in the actual spec text, not assumptions.
- Pay special attention to `./docs/specs/0000_agentic-development-environment.md`. It defines the repository foundation and the Claude Code agentic environment (tooling, conventions, CLAUDE.md, verification harness, scripts, etc.). This spec is special in two ways:
  1. **A foundation subset of it must be built first**, before any product tasks, so that Claude Code can implement everything else efficiently on top of it (fast feedback loops, test/lint/typecheck commands, project scaffolding, agent guidance files).
  2. **The rest of it is built incrementally**, interleaved among product tasks at the logically correct moments (e.g., add an e2e harness right before/after the first feature that needs e2e verification, not on day one).
  When you assign each part of spec 0000, explicitly decide: "foundation phase" or "just-in-time, before/after task X" — and record which spec sections went where so full coverage is auditable.

## Understand the specs
- Read EVERY file under `./docs/specs/` before planning anything.
- Build a mental model of the feature: its components, data flow, dependencies, interfaces, and external integrations.
- Note any ordering constraints.

## Task sizing rules (the most important constraint)

Each task must be completable **and verifiable** by a Claude Code agent within a single context window (<80,000 tokens). Concretely:

- One coherent unit of work: roughly one feature slice, one module, one migration, or one integration — not "build the backend."
- **Not too small:** Don't create trivial one-line tasks. Each task should be a coherent, self-contained unit of work that produces something meaningful
- Touches a bounded set of files the agent can hold in mind (guideline: ≤ ~10-15 files changed, ≤ ~500-800 lines of new code; split anything larger).
- Has a **mechanical verification step** the agent can run itself at the end (tests pass, typecheck passes, a script produces expected output, a curl command returns expected JSON). "Looks right" is not verification.
- Leaves the repository in a **green, working state** — every task ends with all existing checks passing. No task may depend on a future task to compile or pass tests.
- Requires no information outside: the task file itself, the referenced spec sections, and the current repository state. The agent starting the task has **zero memory** of previous sessions — write each task as if for a skilled engineer seeing the repo for the first time.
- Prefer **vertical slices** (thin end-to-end functionality) over horizontal layers wherever the architecture allows, so every task produces something demonstrable.

If a spec area cannot be reduced to tasks of this size, decompose it further (interface-first: define contracts/types in one task, implement behind them in following tasks).

## Keep tasks scoped, not over-detailed
Each task description should communicate SCOPE and POINT TO THE SOURCE OF TRUTH, not re-document the spec:

- Reference the exact spec file(s) and section(s) the agent must read to get full detail.
- Do NOT copy large portions of the spec into the task. The agent will read the original. Your job is to delineate boundaries, not duplicate content.

## Ordering rules

1. **Phase 0 — Foundation**: the minimal subset of spec 0000 needed for the agent loop: repo scaffolding, package/dependency setup, CLAUDE.md and agent conventions, formatter/linter/typechecker, test runner with one passing smoke test, basic CI, and the standard verification commands every later task will use.
2. **Walking skeleton**: the thinnest end-to-end path through the system (even if it does almost nothing) so all subsequent tasks extend a working whole.
4. Interleave remaining spec-0000 items just-in-time, immediately before the first task that needs them.
5. Every task lists its explicit dependencies by task ID. No circular dependencies. Where tasks are independent, say so — they may be parallelized.

## Output

Create the following (this is your only deliverable — again, no implementation):

### 1. `./docs/plan/ROADMAP.md`
- Phase overview (Phase 0, walking skeleton, then feature phases/milestones).
- A dependency graph of all tasks (Mermaid diagram plus a plain list).
- A spec coverage matrix: every spec file and major section mapped to the task(s) that implement it. Flag anything intentionally deferred or out of scope. **No spec requirement may be silently dropped.**
- Open questions / ambiguities found in the specs, each with your chosen assumption. Do not block on them; decide and record.

### 2. `./docs/plan/tasks/NNNN_short-name.md` — one file per task
Zero-padded, gap-numbered (0010, 0020, …) so tasks can be inserted later. Each task file uses exactly this template:

```markdown
# NNNN — <Task title>

**Phase:** <phase/milestone>
**Depends on:** <task IDs, or "none">
**Spec references:** <file names + section headings this task implements>

## Objective
One paragraph: what exists after this task that did not exist before, and why now.

## Context for the agent
What a fresh agent must know: relevant architecture decisions, where things live
in the repo, conventions to follow, pitfalls. Assume no memory of prior sessions.

## Scope
- In scope: explicit list of deliverables (files, endpoints, behaviors).
- Out of scope: adjacent things the agent must NOT build yet (name them to
  prevent scope creep).

## Implementation notes
Suggested approach, key interfaces/types to define, edge cases and failure modes from the spec
that must be handled. Guidance, not a straitjacket.

## Verification (definition of done)
Numbered, mechanical steps with exact commands and expected results, e.g.:
- `npm test` — all tests pass, including new tests for X and Y.
- Cover both functional behavior and any quality bar (tests, error handling, edge cases, failure modes etc.) called for by the spec.
All pre-existing checks must also still pass.
```

### 3. `./docs/plan/EXECUTION.md`
The standard operating procedure a Claude Code agent follows for every task: read ROADMAP context → read the task file → read referenced spec sections → implement → run verification → update the task status ledger → commit with a conventional message referencing the task ID. Include the status ledger itself (a simple table of task ID / status / notes) or reference where it lives.

## Process to follow in this session

1. Read all specs fully; take structured notes on components, dependencies.
2. Draft the phase structure and dependency graph; sanity-check that Phase 0 is truly minimal and the walking skeleton comes early.
3. Write the coverage matrix **before** writing task files, then generate task files from it — this guarantees nothing is dropped.
4. Self-review every task against the sizing rules; split any that fail.
5. Do a final pass verifying: no forward dependencies, every task independently verifiable, every spec section covered or explicitly deferred, spec-0000 items each assigned to foundation or a just-in-time slot.

Begin by listing the files in `./docs/specs/` and confirming you will read all of them.
