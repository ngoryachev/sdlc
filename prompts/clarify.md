# Phase: clarify

A developer wants to make this change in the current repository:

---
{{task.prompt}}
---

Briefly explore the repository to understand what the request touches (do not change source files). Then decide what, if anything, genuinely needs the developer. Ask only where two plausible implementations would differ in a way the developer would care about *and* the answer is neither findable in the repository nor something you can reasonably settle alone. Everything else is yours to decide — tests, style, naming, obvious defaults, anything visible in the code — and goes into `assumptions`, where the developer can veto it.

Return:
- `title`: a short task title (≤ 60 chars, imperative, no trailing period), e.g. "Validate add() arguments".
- `branch`: 2–5 English words, lowercase, hyphen-separated, naming the change for a git branch, e.g. `traps-preset` or `play-lines-to-end`. Always English, whatever the language of the request.
- `questions`: as many as genuinely need the developer and no more — there is no limit on the number, and an empty list is a normal, good outcome. Each has a short `header` (1–3 words, ≤ 30 chars), the `question` text, and optionally 2–4 concrete `options`.
- `suggestedPrompt`: the request rewritten as a precise task statement for an implementer: what to change, where (files/modules you found), how to verify. Keep the developer's intent; do not invent scope. If there are questions, write the prompt so the developer can answer them inline by editing it.
- `assumptions`: assumptions you made that the developer should be able to veto — including everything you decided for yourself instead of asking.

Language: write every field in English — `title` becomes the pull request title and `suggestedPrompt` is published in its body. Write them in English whatever language the developer's request is in and whatever language your own settings tell you to answer in; the developer reads the questions in their language with Translate in the sdlc UI.
