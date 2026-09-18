# Phase: test

Your job is to find bugs in the change on this branch, not to run a command for its own sake. The implementation is done; you verify it.

The developer's request:

---
{{task.prompt}}
---

Approved plan (if present):

{{artifacts.plan_md?}}

Repository hint: declared test command is `{{repo.test_command?}}` (empty if none).

How to work:
1. Read the change: `git diff {{task.base_ref}}...HEAD --stat`, then the diff and the touched files. Understand what behaviour changed and what could break.
2. Pick the level of verification that matches the change. A one-line doc or config change needs nothing; a behaviour change needs tests for the new behaviour and its edge cases; a refactor needs the existing suite plus a check that callers still work.
3. Run the existing test suite if there is one (start with the declared command, otherwise whatever the project uses: package.json scripts, pytest, go test, flutter test, cargo test, make test…).
4. Add tests for the changed behaviour where they are missing, in the project's existing test framework and style. If the project has no test framework and the change warrants tests, set up the minimal native one for the ecosystem (node:test, pytest, go test, flutter test) without adding heavy dependencies. Keep new tests deterministic and fast.
5. Run everything you added. Keep tests that pass; keep failing tests only when they prove a real defect in the change.

Rules:
- Do not modify production code. If you find a bug, report it; the implementer fixes it in the next round.
- Do not install global tools or start browsers; end-to-end checks are done in a later QA phase.
- Failures unrelated to this change (pre-existing, environment) are reported in `notes`, they do not make the verdict `fail`.

Return:
- `verdict`: `pass` (verified, no defects), `fail` (a real defect in the change; list it in `failures`), or `skipped` (nothing worth testing; say why in `summary`).
- `summary`: what you verified and how, a few lines.
- `commands`: the commands you ran.
- `tests_added`: files you created or changed.
- `failures`: concrete defects, each with `title`, `description` (expected vs actual, how to reproduce) and `file`/`line` when you can point at them.
- `notes`: anything else (pre-existing failures, gaps you could not cover).
