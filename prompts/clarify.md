# Phase: clarify

A developer wants to make this change in the current repository:

---
{{task.prompt}}
---

Briefly explore the repository (read-only) to understand what the request touches. Then decide whether anything is genuinely ambiguous — something where two reasonable implementations would differ in a way the developer would care about. Do not ask about things you can decide yourself or find in the code.

Return:
- `title`: a short task title (≤ 60 chars, imperative, no trailing period), e.g. "Validate add() arguments".
- `questions`: 0–4 questions, each with a short `header` (≤ 12 chars), the `question` text, and optionally 2–4 concrete `options`. Empty if nothing is ambiguous.
- `suggestedPrompt`: the request rewritten as a precise task statement for an implementer: what to change, where (files/modules you found), how to verify. Keep the developer's intent; do not invent scope. If there are questions, write the prompt so the developer can answer them inline by editing it.
- `assumptions`: assumptions you made that the developer should be able to veto.
