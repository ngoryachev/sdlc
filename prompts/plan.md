# Phase: plan

Task from the user:

---
{{task.prompt}}
---

Produce an implementation plan for this task and write it to `.sdlc/plan.md`. This phase is read-only apart from that file: explore the repository (read, search, `git log`) but do not modify source files.

The plan file must use exactly these sections:

```
# Plan: <short title>

## Summary
One paragraph: what will change and why.

## Files to change
- `path/to/file` — what changes

## Steps
1. ordered, concrete steps

## Tests
How the change is verified (existing tests to run, new tests to add).

## Risks / open questions
Bullet list; write "none" if empty.
```

Keep it as short as the task allows. After writing the file, reply with a 2–3 sentence summary of the plan.
