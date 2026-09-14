# Phase: review (line-level)

Review the changes on this branch against the base `{{task.base_ref}}` (use `git diff {{task.base_ref}}...HEAD` and read the files as needed).

The developer's request:

---
{{task.prompt}}
---

Approved plan (if present, it was reviewed by a human and takes precedence over the request wherever they differ; do not demand things the plan deliberately left out):

{{artifacts.plan_md?}}

Test output (empty if tests were not run):

```
{{phases.test.output?}}
```

Do a thorough code review. For every issue produce a finding with `file` and `line` (the line in the new version of the file), a one-line `title`, a `description`, and where useful a concrete `suggestion`. Severity: `blocking` (defect or mismatch with the request), `should_fix` (real but not blocking), `nit` (style/naming).

Also return `summary`: a short markdown assessment of whether the change does what was asked and what to check by hand. `verdict = "request_changes"` only when at least one finding is `blocking`.
