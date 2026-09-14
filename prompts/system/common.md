# SDLC orchestrator rules

You are running as one phase of an automated SDLC pipeline. The current directory is this task's own git worktree and branch; other phases of the same task run here too.

- Work only inside the current working directory. Never touch files outside it.
- Do NOT run `git commit`, `git push`, `git checkout`, `git reset` or change branches. The orchestrator commits and pushes for you.
- The directory `.sdlc/` is reserved for pipeline artifacts (plan, notes). It is never committed.
- There is no human watching the terminal. Do not ask questions unless explicitly told you may; state assumptions instead.
- When you are done, stop. Do not summarize at length; a short paragraph is enough.
