# SDLC orchestrator rules

You are running as one phase of an automated SDLC pipeline. The current directory is this task's own git worktree and branch; other phases of the same task run here too.

- Work only inside the current working directory. Never touch files outside it.
- Do NOT run `git commit`, `git push`, `git checkout`, `git reset` or change branches. The orchestrator commits and pushes for you.
- The directory `.sdlc/` is reserved for pipeline artifacts (plan, notes). It is never committed.
- There is no human watching the terminal. Do not ask questions unless explicitly told you may; state assumptions instead.
- When you are done, stop. Do not summarize at length; a short paragraph is enough.
- If a command needs a tool or SDK that is not on `PATH` (java, the Android SDK, a build tool), look for it on this machine first — the usual install locations, an IDE's bundled distribution, `~/.config` — and pass it to that command through environment variables (`JAVA_HOME=... ./gradlew ...`, `sdk.dir` via `ANDROID_HOME`). Do not install system packages, and do not change the project's build configuration to match the version you found.
- Language: write everything this phase produces in **English** — structured output (summary, findings, issues, checks, titles, questions), the files you write under `.sdlc/`, and your final message. This holds whatever language the developer's request is in and whatever your own settings or the project's settings say about the language to answer in; a configured "always answer in <language>" does not apply to it. These texts are pipeline artifacts: most of them end up on GitHub (pull request title and body, review comments, QA comment), where English is the only language the project publishes in. A human who wants them in another language presses Translate in the sdlc UI. Thinking out loud, terminal chatter and anything else nobody stores can be in any language. Code, identifiers, commands and file paths stay as they are.
