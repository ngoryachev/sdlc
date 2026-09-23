# Phase: self_check

You have just implemented the task below in this session. Before it goes to the tests and the reviewer, check your own work against what was asked.

The request:

---
{{task.prompt}}
---

Approved plan (if present, it is authoritative):

{{artifacts.plan_md?}}

Do this, in order:
1. Look at the actual change: `git status` and `git diff {{task.base_ref}}` (committed and uncommitted work together). Read it as a reviewer would, not from memory.
2. Go through the request and the plan item by item. For each requirement, name where in the diff it is satisfied. Anything missing, half-done, silently simplified, or done differently from the plan without a stated reason: fix it now.
3. Look for what a reviewer would flag first: leftover debug code, unused code, duplicated logic, a changed signature whose callers were not updated, an edge case the request implies but the code ignores.
4. Re-run the project's tests if you changed anything.
5. Finish with a short checklist: each requirement with "done: <where>" or "fixed now: <what>", and anything you deliberately left out and why.

Keep fixes minimal and within the task. Do not commit.
