Execute the next task from the implementation plan.

1. Read docs/plan/STATUS.md. Pick the first task that is not `done`.
   - If it is `in_progress` or `blocked`, stop and report instead.
2. Ground yourself per docs/plan/EXECUTION.md exactly for that task: read the ROADMAP context,
   the task file, and every referenced spec section.
3. Clarify — only if genuinely needed. After grounding (never before), if
   something material remains ambiguous — a spec conflict not covered by
   ROADMAP §3, an unstated constraint or hard no, a trade-off where
   reasonable people would disagree — interview me before implementing:
   small focused batches (3–5 questions, grouped by topic), wait for my
   answers, drill deeper when an answer opens a new question. If you catch
   yourself about to assume something material, that's a question, not an
   assumption. But do not ask about things the plan, specs, or repo already
   answer — most tasks need zero questions.
4. Implement and verify per EXECUTION.md: run every verification step in
   the task file plus `npm run verify`; update STATUS.md; commit with the
   task ID.
5. Do exactly one task, then stop and summarize: what was built, verification
   results, notes recorded in STATUS.md, and any entries you appended to
   docs/plan/SUGGESTIONS.md — plus a "Human attention" section listing
   anything that needs my input or awareness: decisions or assumptions you
   made beyond the plan, spec contradictions found, skipped or
   credential-gated verification steps, required secrets/keys/funding or
   other manual setup, anything touching real money, and risks or follow-ups
   for later tasks. Write "none" if empty.
