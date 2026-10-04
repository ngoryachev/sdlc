#!/usr/bin/env bash
# Update the running sdlc server: pull, build and test in the server's checkout, back up the database, restart.
# The server is restarted only when the build and the tests pass; otherwise the checkout returns to the commit it was on
# and the old version keeps running. Tasks in flight resume by themselves after the restart.
#
#   bash ~/.sdlc/app/deploy/update.sh [--force]     --force: rebuild and restart even when there is nothing new
set -euo pipefail
APP="${SDLC_DIR:-$HOME/.sdlc/app}"
DATA="${SDLC_HOME:-$HOME/.sdlc}/data"
PORT="${SDLC_PORT:-7337}"
cd "$APP"

before="$(git rev-parse HEAD)"
git pull -q --ff-only
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then echo "already up to date (${after:0:7})"; exit 0; fi
echo "== ${before:0:7} -> ${after:0:7}"

rollback() {
  echo "!! update failed: back to ${before:0:7}, the running server was not touched"
  git reset -q --hard "$before"
  npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 || echo "!! could not rebuild ${before:0:7}; run npm ci && npm run build in $APP by hand"
}
trap rollback ERR
npm ci --no-audit --no-fund
npm run build
npm test
trap - ERR

if systemctl --user cat sdlc >/dev/null 2>&1; then ctl() { systemctl --user "$@"; }
elif systemctl cat sdlc >/dev/null 2>&1; then ctl() { sudo systemctl "$@"; }
else echo "== built and tested; no sdlc unit found, restart the server by hand"; exit 0; fi

echo "== restart"
ctl stop sdlc
# the database as it was before the new version touched it: a migration is undone by putting these files back
mkdir -p "$DATA/backup"
for f in sdlc.db sdlc.db-wal sdlc.db-shm; do rm -f "$DATA/backup/$f"; [ -f "$DATA/$f" ] && cp "$DATA/$f" "$DATA/backup/$f"; done
echo "$before" > "$DATA/backup/commit"
ctl start sdlc

for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then echo "== running ${after:0:7}"; exit 0; fi
  sleep 1
done
echo "!! the server does not answer on port $PORT. Look at: journalctl --user -u sdlc -n 30"
echo "   to go back: stop the unit, copy $DATA/backup/sdlc.db* over $DATA/, git reset --hard $(cat "$DATA/backup/commit") in $APP, npm ci && npm run build, start the unit"
exit 1
