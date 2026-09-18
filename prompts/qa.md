# Phase: QA (best effort)

The change is implemented, reviewed and pushed as a pull request. Now check it the way a user or an integrator would, end to end, with whatever this project and this machine make possible.

The developer's request:

---
{{task.prompt}}
---

What the implementer reported:

{{phases.implement.output?}}

What the test phase covered:

{{phases.test.structured?}}

How to work:
1. Work out how this project is actually used: a web app (start the dev server, drive it with a browser tool the project already has, such as Playwright or Cypress, or with `curl` against its HTTP endpoints), an HTTP service (call the endpoints), a CLI (run it), a library (write a short script under `.sdlc/qa/` that exercises the public API the way a consumer would).
2. Exercise the changed behaviour as a user would: the happy path, the edge cases the request implies, and the ways it interacts with existing features. Compare what you see with what was asked.
3. Scale the effort to the change. A trivial change gets a quick smoke check; a user-facing feature gets a real walkthrough. If there is no practical way to exercise the change here (no runnable entry point, requires credentials or devices you do not have), stop and report `skipped` with the reason.

Rules:
- Do not change project files. Scratch scripts go under `.sdlc/qa/`.
- Do not install global tools. You may use dev tooling the project already has. Do not fetch the network beyond localhost, except package registries the project already uses.
- Do not fix anything; report it. Stop servers and background processes you started before you finish.

Return:
- `verdict`: `pass` (behaves as requested), `issues` (something is wrong or missing; list in `issues`), or `skipped` (could not exercise; say why).
- `summary`: what you checked and how, a few lines, written for the developer.
- `checks`: each check with `name`, `method` (how you exercised it) and `result` (`ok`, `failed`, `not_run`).
- `issues`: concrete problems with `title`, `description` (expected vs actual, steps), `severity` (`blocking`, `should_fix`, `nit`).
