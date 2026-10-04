# sdlc: notes for agents working on this repository

Thin SDLC orchestrator on top of Claude Code: `server/` (Hono API + engine, TypeScript), `ui/` (React), `shared/` (types), `pipelines/*.yaml`, `prompts/*.md`, `schemas/*.json`, `test/` (vitest; a scripted fake Claude runner and a fake GitHub, no network).

## Commands

- `npm run typecheck` — shared + server; `cd ui && npx tsc --noEmit -p .` — UI
- `npm test` — everything, about 10 seconds; `npx vitest run test/e2e/<file>` for one file
- `npm run build` — shared, server, UI

## Rules that protect the running server

A live sdlc server runs on this machine from its own checkout (`~/.sdlc/app`) with real tasks in `~/.sdlc`. You are most likely being run by it.

- Never start `sdlc serve`, `npm start` or `npm run dev` against the real data. To see the app run, give it its own data and port **inside the same command**, because `SDLC_*` variables are stripped from your environment: `SDLC_HOME=$(mktemp -d) node server/dist/cli/index.js serve --port 7400`. Stop it when done.
- Never touch the service: no `systemctl ... sdlc`, no edits under `~/.sdlc/`, `~/.config/systemd/`, no `deploy/update.sh`. Deploying is the human's step after the change is merged.
- Do not use the real `gh` or Claude in tests. New behaviour gets a test on `FakeRunner` / `FakeGitHub` (`test/fakes/`); HTTP-level behaviour is tested through the Hono app (see `test/unit/hil-route.test.ts`), not only through the engine.

## Things that are easy to break

- Database changes: append to `MIGRATIONS` in `server/src/store/db.ts`, never edit an existing entry; `insertTask` / `insertRun` / `insertPhaseRun` in `server/src/store/repo.ts` are positional, new columns go last.
- A task run stores a snapshot of its pipeline (`pipelineSnapshot`). Old snapshots must keep loading: new pipeline and phase fields need defaults.
- A new field in an HTTP body must be added to the zod schema of its route, or it is silently dropped.
- Prompts are read from disk when a phase starts; pipelines when a task is created.
