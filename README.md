# sdlc — thin SDLC orchestration on top of Claude Code

Runs a coding task through explicit phases (`clarify → refine → plan → approve → implement → self_check → commit → test → review → approve → PR → qa`),
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
max_parallel_tasks: 10
max_loops: 15              # cap on test→implement / review→implement loops before escalating (overrides pipelines)
recheck_scope: delta       # a repeat pass of review/test/qa checks only what changed since its previous pass (full: everything again)
task_budget_usd: 20        # or off
limits: { phases: pipeline }   # off: ignore max_turns / max_budget_usd from pipelines
merge_method: merge        # merge | squash | rebase, used by Land
models: { default: opus, effort: high, phases: { review: { model: sonnet } } }   # also editable in the UI (Settings)
cleanup: never            # never (default: remove explicitly, UI button or `sdlc cleanup`) | on_pr | on_approve
repos:
  - { name: shop, path: /home/me/Develop/shop, gh_user: me }   # gh_user: GitHub account for this repo (auto-detected; editable in Settings)
pr_sync_interval: 3m      # background check of PR states and merged branches (off to disable)
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

- Web UI: create a task (prompt, repo — local or cloned from GitHub via `gh`, base remote/branch, pipeline, review mode, models for this task). A task works on a new branch, an existing branch, or a **pull request** (its head branch becomes the task branch, its base the task base; the prompt then defaults to the PR title and body). Any task runs a **segment** of its pipeline (from phase / to phase); phases outside it are recorded as skipped, and the prompt may be omitted when the segment starts after `implement` on an existing branch (a short summary of the branch is generated). Watch phases live, pause / inject a message / abort. **Land** merges the task branch into its base (through the PR when there is one, otherwise a local merge + push), removes the worktree and the branch, status `merged`.
- Delivery. A task whose pipeline finished without a PR shows as **ready to land**; the dashboard hides only merged, closed and aborted tasks. **Create PR** pushes the branch and opens a PR into its base (after catching up with commits merged into the branch on GitHub). **Land** merges (through the PR when there is one), moves tasks stacked on the branch onto its base (their PRs are retargeted on GitHub before the branch is deleted; with a stack only `merge` is allowed, and running stacked tasks block it), then removes the worktree and the branch. **Close** drops a task without merging (closes its PR, optionally deletes the branch). A background sync (`pr_sync_interval`) turns PRs merged or closed on GitHub into `merged`/`closed` with the same cleanup, follows base changes made on GitHub, and notices branches merged by hand. The task page shows the base chain and the tasks stacked on the branch.
- GitHub accounts. Every repository has its own account (`repos[].gh_user`, auto-detected as the first logged-in `gh` account that can push there); all pushes, PRs and merges for that repository use its token, whatever account is active in `gh`. The repository picker lists cloned repositories first, then every repository the selected account can see (own, collaborator, organisations); picking one that is not cloned clones it with that account.
- Models and effort: Settings holds global defaults and per-phase-type values (list from the CLI via `supportedModels()`); a task can override them for its own phases (form or task page). They are resolved when each phase starts, so edits apply to the next phase of any task.
- HIL queue (`/hil`): refine the prompt (Claude's clarifying questions, each needs an answer), approve or edit the plan, decide on the result item by item (every review finding or QA issue is **fix** → back to the implementer with exactly those items, **post** → published on the pull request, or **skip**), answer Claude's questions, handle escalations. A reviewer task also picks the GitHub review event (comment / approve / request changes). Keyboard: `a` approve, `r` comment, `Ctrl+Enter`, `j/k`.
- `self_check` continues the implement session: the implementer re-reads its own diff against the request and plan, fixes gaps, and reports a checklist (best effort, never blocks).
- The `test` phase is an agent, not a command: it reads the diff, runs the existing suite, writes tests for the changed behaviour (in the project's framework, or a minimal native one), and returns `pass|fail|skipped`; `fail` loops back into the implement session with the defects. The pull request is opened right after the tests, before review, so review and everything after it happen on the PR. The `review` verdict follows its findings: any `blocking` or `should_fix` finding means `request_changes` and one more implement round; `nit` only means `approve`. Fixes picked by the human at `approve_result` go implement → commit → push → review (`then_goto: review`, the test phase is not repeated); the `publish` phase posts the findings marked `post`. A best-effort `qa` phase then exercises the change end to end (dev server, HTTP, CLI, consumer script), posts its report as a PR comment and opens a gate only when it found issues; fixes from that gate return straight to QA. A repeat pass of review, test or qa is told what it saw last time and checks only the diff since then (`recheck_scope: delta`). Neither phase needs any repo config.
- When its segment is done the task is `pr_open` and the background sync keeps watching the PR. A task whose segment contains `implement` (the author side) gets new review comments as a `pr_feedback` request, comment by comment **fix** or **skip**; the fixes go through the rest of its segment and are pushed, and the reviewers get one "addressed" comment per round. A task that only reviews (the reviewer side, e.g. `review-pr`) starts its review again when the PR gets new commits, narrowed to them, and the findings again wait for you before anything reaches the PR. **Poll PR comments** (`sdlc pr <task>`, Telegram `/pr <task>`) does the author-side check on demand.
- Telegram: the bot posts each HIL request with Approve/Abort buttons and an Open link. `/status` lists active tasks.
- CLI mirrors the UI and talks to the running server (falls back to in-process when no server): `sdlc new "<prompt>" --repo <path> [--pipeline quick] [--base origin/main]`, `sdlc new … --from <phase> --to <phase> --branch <existing>`, `sdlc new --repo <path> --pr <n> [--pipeline review-pr]`, `sdlc land <task> [--method squash]`, `sdlc create-pr <task> [--title …] [--draft]`, `sdlc close <task> [--delete-branch] [--keep-pr]`, `sdlc sync`, `sdlc list`, `sdlc show <task>`, `sdlc hil`, `sdlc hil-show <hil> [--diff]`, `sdlc approve <hil> [--title …] [--prompt …|--plan file]`, `sdlc changes <hil> -m "…"`, `sdlc answer <hil> --answer "q=a"`, `sdlc decide <hil> retry|resume|skip|abort`, `sdlc pause|resume|abort|inject <task>`, `sdlc pr <task>`, `sdlc tail <task>`, `sdlc cleanup <task>` (remove the worktree; the branch stays).
- Dev: `sdlc run-phase --repo <dir> --prompt-file prompts/plan.md --mode dontAsk --write-scope '.sdlc/**'` runs one phase and prints the stream.

## Pipelines

`pipelines/*.yaml` (add your own dirs via `pipelines_dirs`). Phase types:

| type | keys |
|---|---|
| `claude` | `prompt` (md, templated), `permission_mode`, `allowed_tools`, `disallowed_tools`, `write_scope`, `output_schema`, `artifacts`, `session: fresh \| {resume: <phase>}`, `mode`, `fail_if`, `max_turns`, `max_budget_usd`, `model`, `effort` |
| `shell` | `command` (templated, runs in the worktree), `timeout_sec`, `tail_lines` |
| `hil` | `hil: refine_prompt \| approve_plan \| approve_result`, `back_to`, `then_goto` (fast return: after `back_to` only git phases run until this phase), `timeout` |
| `git` | `git: commit \| push \| pr \| comment \| review`, `message`, `pr: {draft, title, body}`, `body` (comment template); `review` publishes the findings marked `post` at the last `approve_result` |

Flow control on any phase: `when: <expr>` (skip when false), `on_fail: { retry, back_to, feedback, max_loops, then: hil|fail|continue }` (`continue` skips a best-effort phase), `on_success: { goto }`.
`back_to` resumes the target phase's Claude session with `feedback` as the next message — that's how test output and review findings reach the implementer with full context.

Templates: `{{task.prompt}}`, `{{task.base_ref}}`, `{{phases.<name>.output|structured|status|attempt}}`, `{{artifacts.<name>}}`, `{{hil.<phase>.comment}}`, `{{loop.feedback}}`, `{{recheck.note}}` (set on a repeat pass), `{{repo.test_command}}`; `{{x?}}` for optional.
Expressions: `repo.test_command`, `structured.verdict == 'request_changes'`, `!a && (b || c)`.

Shipped: `standard` (all checkpoints), `quick` (no separate plan), `auto` (no checkpoints, no PR; for trivial tasks), and two presets that are segments of `standard`: `review-pr` (`extends: standard`, `segment: {from: review, to: publish}`: review someone's PR) and `fix-pr` (`segment: {from: implement, to: pr}`, `wait_for_feedback: true`: fix review comments on a PR). A pipeline's `segment` is the default slice a task runs; the task form can narrow or widen it.

Branches are named `sdlc/<slug>-<id>` where the slug is a 2–5 word English summary of the task (a short haiku call at creation; clarify's `branch` field after refine), as long as the branch has not been pushed.

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
