# Phase: review

Review the changes on this branch against the base `{{task.base_ref}}` (use `git diff {{task.base_ref}}...HEAD` and read the files as needed).

The developer's request:

---
{{task.prompt}}
---

Approved plan (if present, it was reviewed by a human and takes precedence over the request wherever they differ; do not demand things the plan deliberately left out):

{{artifacts.plan_md?}}

Result of the test phase (empty if it did not run):

{{phases.test.structured?}}

Evaluate the result against the intent, not against style preferences:
- Does it do what was asked, fully? Anything silently simplified, skipped or over-built?
- Correctness risks: edge cases, error handling, regressions in callers.
- Design concerns worth a sentence (only if they matter).
- What would you check by hand before merging?

Return `summary` as markdown for a human (a few short paragraphs or bullets). Put concrete defects into `findings` with severity `blocking` (a real defect or a clear mismatch with the request), `should_fix` (wrong or fragile enough that it should not ship as is), or `nit` (style, naming, optional polish); include `file` and `line` when you can point at them. The verdict follows the findings: `request_changes` when there is at least one `blocking` or `should_fix` finding, `approve` when findings are empty or `nit` only. Do not invent findings to have something to say.
