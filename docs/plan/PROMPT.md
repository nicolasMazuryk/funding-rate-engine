Execute the next task from the implementation plan.

1. Read docs/plan/STATUS.md. Pick the first task that is not `done`.
   - If it is `in_progress` or `blocked`, stop and report instead.
2. Follow docs/plan/EXECUTION.md exactly for that task: read the ROADMAP
   context, the task file, and every referenced spec section; implement;
   run every verification step in the task file plus `npm run verify`;
   update STATUS.md; commit with the task ID.
3. Do exactly one task, then stop and summarize: what was built, verification
   results, and any notes recorded in STATUS.md — plus a "Human attention"
   section listing anything that needs my input or awareness: decisions or
   assumptions you made beyond the plan, spec contradictions found, skipped
   or credential-gated verification steps, required secrets/keys/funding or
   other manual setup, anything touching real money, and risks or follow-ups
   for later tasks. Write "none" if empty.
