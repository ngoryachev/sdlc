# sdlc — thin SDLC orchestration on top of Claude Code

Runs a coding task through explicit phases (`clarify → refine → plan → approve → implement → commit → test → review → approve → PR → qa`),
Each task gets its own git worktree and branch; every phase is one Claude Code session (via the Agent SDK) running inside that worktree.
Humans step in only at declared checkpoints (HIL), from a web UI or Telegram. Everything is observable live.

## Requirements

- Node 22.x (uses `node:sqlite`), npm
- Claude Code CLI installed and logged in (`claude`); the SDK spawns it
- git; `gh` (GitHub CLI) for PRs, PR feedback and cloning repos from GitHub

## Install & run

```bash
npm install
npm run build                # shared + server + ui
node server/dist/cli/index.js serve      # or: npm start
# dev: npm run dev (tsx watch + vite on :5173 proxying /api to :7337)
```

On first start the server generates an access token and prints a login link `http://…:7337/?t=<token>`.
Open it once per browser (cookie is set). Config lives in `~/.sdlc/config.yaml` (created on first save), data in `~/.sdlc/data/`.

```yaml
# ~/.sdlc/config.yaml (all keys optional)
server: { host: 0.0.0.0, port: 7337, public_url: http://192.168.1.10:7337 }   # host 0.0.0.0 to open from a phone
default_pipeline: standard
max_parallel_tasks: 2
task_budget_usd: 20
cleanup: never            # never (default: remove explicitly, UI button or `sdlc cleanup`) | on_pr | on_approve
repos:
  - { name: shop, path: /home/me/Develop/shop }
telegram: { enabled: true, bot_token: "123:abc", chat_id: "42" }   # or env SDLC_TELEGRAM_TOKEN
```

Per-repository settings in `<repo>/.sdlc.yaml`:

```yaml
test_command: npm test          # hint for the agentic `test` phase (it finds the test setup itself when unset)
setup_command: npm ci           # run once in every new worktree (dependencies); task creation fails if it fails
base_branch: main               # default base; the task form can override (remote/branch)
allow: ["Bash(make *)"]         # extra allow rules for phases that are not in bypassPermissions
copy_untracked: [.env]          # copied into each new worktree
review_mode: conceptual         # conceptual | line
post_review: false              # post line-level findings to the GitHub PR
```

## Using it

- Web UI: create a task (prompt, repo — local or cloned from GitHub via `gh`, base remote/branch, pipeline, review mode). Watch phases live, pause / inject a message / abort.
- HIL queue (`/hil`): refine the prompt (Claude's clarifying questions + rewritten prompt), approve or edit the plan, accept the result (review, diff, tests), answer Claude's questions, handle escalations. Keyboard: `a` approve, `r` comment, `Ctrl+Enter`, `j/k`.
- The `test` phase is an agent, not a command: it reads the diff, runs the existing suite, writes tests for the changed behaviour (in the project's framework, or a minimal native one), and returns `pass|fail|skipped`; `fail` loops back into the implement session with the defects. The `review` verdict follows its findings: any `blocking` or `should_fix` finding means `request_changes` and one more implement round; `nit` only means `approve`. After the PR, a best-effort `qa` phase exercises the change end to end (dev server, HTTP, CLI, consumer script), posts its report as a PR comment and opens an `approve_result` checkpoint only when it found issues. Neither phase needs any repo config.
- After the PR exists the task is `pr_open`. Press **Poll PR comments** (or `sdlc pr <task>`, Telegram `/pr <task>`) to pull new review comments into a `pr_feedback` request; approving sends them into the implement session, then commit → test → review → push → PR comment.
- Telegram: the bot posts each HIL request with Approve/Abort buttons and an Open link. `/status` lists active tasks.
- CLI mirrors the UI and talks to the running server (falls back to in-process when no server): `sdlc new "<prompt>" --repo <path> [--pipeline quick] [--base origin/main]`, `sdlc list`, `sdlc show <task>`, `sdlc hil`, `sdlc hil-show <hil> [--diff]`, `sdlc approve <hil> [--prompt …|--plan file]`, `sdlc changes <hil> -m "…"`, `sdlc answer <hil> --answer "q=a"`, `sdlc decide <hil> retry|resume|skip|abort`, `sdlc pause|resume|abort|inject <task>`, `sdlc pr <task>`, `sdlc tail <task>`, `sdlc cleanup <task>` (remove the worktree; the branch stays).
- Dev: `sdlc run-phase --repo <dir> --prompt-file prompts/plan.md --mode dontAsk --write-scope '.sdlc/**'` runs one phase and prints the stream.

## Pipelines

`pipelines/*.yaml` (add your own dirs via `pipelines_dirs`). Phase types:

| type | keys |
|---|---|
| `claude` | `prompt` (md, templated), `permission_mode`, `allowed_tools`, `disallowed_tools`, `write_scope`, `output_schema`, `artifacts`, `session: fresh \| {resume: <phase>}`, `mode`, `fail_if`, `max_turns`, `max_budget_usd`, `model`, `effort` |
| `shell` | `command` (templated, runs in the worktree), `timeout_sec`, `tail_lines` |
| `hil` | `hil: refine_prompt \| approve_plan \| approve_result`, `back_to`, `timeout` |
| `git` | `git: commit \| push \| pr \| comment`, `message`, `pr: {draft, title, body, post_review}`, `body` (comment template) |

Flow control on any phase: `when: <expr>` (skip when false), `on_fail: { retry, back_to, feedback, max_loops, then: hil|fail|continue }` (`continue` skips a best-effort phase), `on_success: { goto }`.
`back_to` resumes the target phase's Claude session with `feedback` as the next message — that's how test output and review findings reach the implementer with full context.

Templates: `{{task.prompt}}`, `{{task.base_ref}}`, `{{phases.<name>.output|structured|status|attempt}}`, `{{artifacts.<name>}}`, `{{hil.<phase>.comment}}`, `{{loop.feedback}}`, `{{repo.test_command}}`; `{{x?}}` for optional.
Expressions: `repo.test_command`, `structured.verdict == 'request_changes'`, `!a && (b || c)`.

Shipped: `standard` (all checkpoints), `quick` (no separate plan), `auto` (no checkpoints, no PR; for trivial tasks).

Base ref: `--base origin/main` or a local branch such as `--base feature/x` (a name whose first segment is not a remote is a local branch). A local-only base is pushed before the PR is created, since GitHub needs it on the remote.

## Safety

- Every phase runs in the task's worktree; `.sdlc/` (plan, transcripts) is excluded from git.
- A PreToolUse hook denies writes outside the worktree / `.git`, enforces `write_scope`, and blocks `git push`, `git commit --amend`, `sudo`, `rm -rf /|~`, `curl | sh` in every mode. `Bash(git commit*)`/`Bash(git push*)` are additionally denied in implement phases; the orchestrator commits.
- Per-phase `max_turns`/`max_budget_usd`, task-level `task_budget_usd` (escalates to a human), `max_parallel_tasks`.
- Credentials-looking env vars (`*TOKEN*`, `*SECRET*`, `AWS_*`, `GH_*`) are not passed to Claude/shell phases (`env_allow` whitelists).

## Tests

`npm test` — unit tests (templates, expressions, schema, store, hooks) and end-to-end pipeline tests against a scratch git repo with a scripted fake Claude runner (`test/fakes/fake-runner.ts`). No API calls.

## Deploy on a server

`deploy/install.sh` (Ubuntu) installs Node 22, `gh`, Claude Code, clones this repo, builds it, writes a public-safe `~/.sdlc/config.yaml`
(`token_in_url: false`, `pr_feedback_from: collaborators`) and registers `deploy/sdlc.service`. Then:

- **Auth:** `gh auth login`; for Claude either log in once with `claude`, or put `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on your laptop) into `/etc/sdlc.env`. Never set `ANTHROPIC_API_KEY` there unless you want API billing.
- **Access:** simplest is a VPN (Tailscale) with `server.host: 0.0.0.0` and no proxy. For a public host use `deploy/Caddyfile` (HTTPS + basic auth, long random password) plus `deploy/fail2ban/` (bans IPs after 5 × 401), and keep `token_in_url: false`: the sdlc token is then entered once per device in the login form and never travels in URLs or Telegram links.
- **Blast radius to keep in mind:** whoever can open the UI can run code on this server as the sdlc user with its `gh` and Claude credentials. Read/Write of Claude phases are confined to the task worktree by hooks (`read_allow` in `.sdlc.yaml` widens reads), secrets-looking env vars are not passed to phases, and PR comments are only ingested from repository collaborators by default.
