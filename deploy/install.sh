#!/usr/bin/env bash
# Ubuntu 22.04/24.04 single-user install of sdlc as a systemd service.
# Usage: sudo -u <devuser> bash deploy/install.sh   (run as the user that will own repos and the Claude login)
set -euo pipefail
SDLC_DIR="${SDLC_DIR:-$HOME/sdlc}"
NODE_MAJOR=22

echo "== packages"
if ! command -v git >/dev/null; then sudo apt-get update && sudo apt-get install -y git curl ca-certificates; fi
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

echo "== sdlc"
if [ ! -d "$SDLC_DIR" ]; then git clone https://github.com/ngoryachev/sdlc.git "$SDLC_DIR"; fi
cd "$SDLC_DIR" && git pull -q && npm install --no-audit --no-fund && npm run build

echo "== config"
mkdir -p "$HOME/.sdlc"
if [ ! -f "$HOME/.sdlc/config.yaml" ]; then
  cat > "$HOME/.sdlc/config.yaml" <<YAML
server:
  host: 127.0.0.1          # Caddy proxies to this; use 0.0.0.0 only inside a VPN
  port: 7337
  public_url: https://CHANGE-ME.example.com
  token_in_url: false      # public deployment: login via the form / Bearer only
pr_feedback_from: collaborators
default_pipeline: standard
max_parallel_tasks: 2
telegram: { enabled: false }
YAML
  echo "wrote ~/.sdlc/config.yaml — edit public_url and telegram"
fi

echo "== systemd"
sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@SDLC_DIR@|$SDLC_DIR|g" -e "s|@NODE@|$(command -v node)|g" deploy/sdlc.service | sudo tee /etc/systemd/system/sdlc.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now sdlc
sleep 2 && sudo systemctl --no-pager status sdlc | head -5

cat <<MSG

Next steps:
  1. gh auth login                       (GitHub, as this user)
  2. Claude: either run \`claude\` once and log in, or put CLAUDE_CODE_OAUTH_TOKEN=... into /etc/sdlc.env (from \`claude setup-token\` on your laptop)
  3. Project toolchains (flutter, python, ...) for this user; \`.sdlc.yaml\` in each repo with test_command / setup_command
  4. Caddy: see deploy/Caddyfile (basic auth + HTTPS); fail2ban: deploy/fail2ban/
  5. Token for the UI login form: grep token ~/.sdlc/config.yaml
MSG
