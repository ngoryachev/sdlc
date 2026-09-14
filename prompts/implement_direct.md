# Phase: implement (direct)

Implement the following task in the current working directory (an isolated git worktree):

---
{{task.prompt}}
---

Steps:
1. Explore only as much as needed. Write a short plan (5–15 lines) to `.sdlc/plan.md`: files to change, steps, how to verify.
2. Implement it.
3. Run the project's tests{{repo.test_command?}} and fix failures caused by your change.
4. Do not commit; the orchestrator commits after this phase.
5. Finish with a short summary: what changed, how it was verified, anything the reviewer should look at.
