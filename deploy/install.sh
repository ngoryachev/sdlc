#!/usr/bin/env bash
# Install sdlc for the current user on Ubuntu 22.04/24.04. Safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/ngoryachev/sdlc/main/deploy/install.sh | bash
#
# The server runs from its own checkout (~/.sdlc/app), apart from any working copy of this repository, as a systemd
# service that starts at boot. Update it with deploy/update.sh.
#   SDLC_DIR=<dir>     where the server's checkout lives (default ~/.sdlc/app)
#   SDLC_UNIT=system   a system-wide unit instead of a user one (public server behind Caddy; needs sudo)
set -euo pipefail
SDLC_DIR="${SDLC_DIR:-$HOME/.sdlc/app}"
SDLC_UNIT="${SDLC_UNIT:-user}"
NODE_MAJOR=22

echo "== packages"
if ! command -v git >/dev/null || ! command -v curl >/dev/null; then sudo apt-get update && sudo apt-get install -y git curl ca-certificates; fi
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - && sudo apt-get install -y nodejs
fi
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update && sudo apt-get install -y gh
fi
if ! command -v claude >/dev/null; then curl -fsSL https://claude.ai/install.sh | bash; export PATH="$HOME/.local/bin:$PATH"; fi

echo "== sdlc in $SDLC_DIR"
if [ ! -d "$SDLC_DIR/.git" ]; then mkdir -p "$(dirname "$SDLC_DIR")"; git clone https://github.com/ngoryachev/sdlc.git "$SDLC_DIR"; fi
cd "$SDLC_DIR" && git pull -q --ff-only && npm ci --no-audit --no-fund && npm run build

echo "== config"
mkdir -p "$HOME/.sdlc"
if [ ! -f "$HOME/.sdlc/config.yaml" ]; then
  if [ "$SDLC_UNIT" = system ]; then
    cat > "$HOME/.sdlc/config.yaml" <<YAML
server:
  host: 127.0.0.1          # Caddy proxies to this; use 0.0.0.0 only inside a VPN
  port: 7337
  public_url: https://CHANGE-ME.example.com
  token_in_url: false      # public deployment: login via the form / Bearer only
pr_feedback_from: collaborators
default_pipeline: standard
telegram: { enabled: false }
YAML
    echo "wrote ~/.sdlc/config.yaml: edit public_url and telegram"
  else
    cat > "$HOME/.sdlc/config.yaml" <<YAML
server:
  host: 127.0.0.1          # 0.0.0.0 plus public_url to open the UI from other devices (LAN, Tailscale)
  port: 7337
default_pipeline: standard
telegram: { enabled: false }
YAML
    echo "wrote ~/.sdlc/config.yaml"
  fi
fi

echo "== systemd ($SDLC_UNIT unit)"
NODE_BIN="$(command -v node)"
if [ "$SDLC_UNIT" = system ]; then
  sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@SDLC_DIR@|$SDLC_DIR|g" -e "s|@NODE@|$NODE_BIN|g" deploy/sdlc.service | sudo tee /etc/systemd/system/sdlc.service >/dev/null
  sudo systemctl daemon-reload && sudo systemctl enable sdlc && sudo systemctl restart sdlc
  sleep 3 && sudo systemctl --no-pager status sdlc | head -5
else
  mkdir -p "$HOME/.config/systemd/user"
  sed -e "s|@SDLC_DIR@|$SDLC_DIR|g" -e "s|@NODE@|$NODE_BIN|g" -e "s|@PATH@|$PATH|g" deploy/sdlc-user.service > "$HOME/.config/systemd/user/sdlc.service"
  systemctl --user daemon-reload && systemctl --user enable sdlc && systemctl --user restart sdlc
  # start at boot, before anyone logs in
  loginctl enable-linger "$USER" 2>/dev/null || echo "could not enable linger: the server will start at login instead of at boot (sudo loginctl enable-linger $USER)"
  sleep 3 && systemctl --user --no-pager status sdlc | head -5
fi

cat <<MSG

Next steps:
  1. gh auth login                       (GitHub, as this user)
  2. Claude: run \`claude\` once and log in, or put CLAUDE_CODE_OAUTH_TOKEN=... into ~/.sdlc/env (from \`claude setup-token\`)
  3. Project toolchains (flutter, python, ...) for this user; \`.sdlc.yaml\` in each repo with test_command / setup_command
  4. Open the UI: the link with the login token is in the log (journalctl --user -u sdlc -n 5), or: grep token ~/.sdlc/config.yaml
  5. Update later: bash $SDLC_DIR/deploy/update.sh
  Public server only: Caddy (deploy/Caddyfile, basic auth + HTTPS) and fail2ban (deploy/fail2ban/).
MSG
