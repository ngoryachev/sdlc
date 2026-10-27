# Phase: clarify

A developer wants to make this change in the current repository:

---
{{task.prompt}}
---

Briefly explore the repository to understand what the request touches (do not change source files). Then decide whether anything is genuinely ambiguous — something where two reasonable implementations would differ in a way the developer would care about. Do not ask about things you can decide yourself or find in the code.

Return:
- `title`: a short task title (≤ 60 chars, imperative, no trailing period), e.g. "Validate add() arguments".
- `branch`: 2–5 English words, lowercase, hyphen-separated, naming the change for a git branch, e.g. `traps-preset` or `play-lines-to-end`. Always English, whatever the language of the request.
- `questions`: 0–4 questions, each with a short `header` (1–3 words, ≤ 30 chars), the `question` text, and optionally 2–4 concrete `options`. Empty if nothing is ambiguous.
- `suggestedPrompt`: the request rewritten as a precise task statement for an implementer: what to change, where (files/modules you found), how to verify. Keep the developer's intent; do not invent scope. If there are questions, write the prompt so the developer can answer them inline by editing it.
- `assumptions`: assumptions you made that the developer should be able to veto.

Language: write every field in English — `title` becomes the pull request title and `suggestedPrompt` is published in its body. Write them in English whatever language the developer's request is in and whatever language your own settings tell you to answer in; the developer reads the questions in their language with Translate in the sdlc UI.
