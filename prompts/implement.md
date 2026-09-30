# Phase: implement

Implement the following task in the current working directory (an isolated git worktree).

Task:

---
{{task.prompt}}
---

Approved plan (`.sdlc/plan.md`, may have been edited by the human; it is authoritative over your own ideas). It is empty when the task has no planning phase; then work from the task statement:

---
{{artifacts.plan_md?}}
---

Rules:
- Follow the plan when there is one. If you must deviate, do so minimally and state why in your final message.
- Run the project's tests when done{{repo.test_command?}}. If tests fail because of your change, fix it.
- Do not commit; the orchestrator commits after this phase.
- Finish with a short summary: what changed, how it was verified, anything the reviewer should look at.
