#!/usr/bin/env bash
# Install rs3mini-bridge on Linux (Raspberry Pi OS, etc.). Idempotent.
#
# Prereq: project files in /opt/rs3mini-bridge (or set INSTALL_ROOT).
# Usage (on the bridge host, as a normal user with sudo):
#   sudo mkdir -p /opt/rs3mini-bridge && sudo chown "$USER:$USER" /opt/rs3mini-bridge
#   rsync -av --exclude node_modules ./ pi@<bridge-host>:/opt/rs3mini-bridge/
#   ssh pi@<bridge-host> 'bash /opt/rs3mini-bridge/scripts/install.sh'

set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "ERROR: run as your SSH user, not root — script uses sudo internally" >&2
  exit 1
fi

INSTALL_ROOT="${INSTALL_ROOT:-/opt/rs3mini-bridge}"
SERVICE_USER="${SERVICE_USER:-$USER}"

if [[ ! -f "$INSTALL_ROOT/server.mjs" ]]; then
  echo "ERROR: $INSTALL_ROOT/server.mjs missing — copy the repo there first" >&2
  exit 1
fi

export DEPLOY_USER="$SERVICE_USER"
if [[ "${SKIP_PREREQS:-0}" == "1" ]]; then
  echo "→ SKIP_PREREQS=1 — npm + systemd only (no apt/setcap/journald)"
else
  bash "$INSTALL_ROOT/scripts/setup-prereqs.sh"
  bash "$INSTALL_ROOT/scripts/setup-journald-retention.sh"
fi

cd "$INSTALL_ROOT"
chmod +x scripts/wait-wifi.sh 2>/dev/null || true
if [[ -f package-lock.json ]]; then
  npm config set fetch-timeout 600000
  npm config set fetch-retries 5
  npm ci --omit=dev
else
  npm install --omit=dev
fi

chmod +x "$INSTALL_ROOT/scripts/apply-site-env.sh" 2>/dev/null || true
if [[ ! -f /etc/rs3mini-bridge.env ]]; then
  if [[ -f /etc/gimbal-bridge.env ]]; then
    sudo cp /etc/gimbal-bridge.env /etc/rs3mini-bridge.env
    echo "→ migrated /etc/gimbal-bridge.env → /etc/rs3mini-bridge.env"
  else
    sudo cp rs3mini-bridge.env.example /etc/rs3mini-bridge.env
    echo "→ created /etc/rs3mini-bridge.env from example"
  fi
  sudo chmod 600 /etc/rs3mini-bridge.env
fi
# Merge gitignored site.env runtime keys (GIMBAL_NAME_RE, PORT, …) when present.
INSTALL_ROOT="$INSTALL_ROOT" bash "$INSTALL_ROOT/scripts/apply-site-env.sh"

if systemctl list-unit-files gimbal-bridge.service &>/dev/null; then
  sudo systemctl disable --now gimbal-bridge 2>/dev/null || true
  echo "→ stopped legacy gimbal-bridge.service"
fi

sudo sed "s/INSTALL_USER/${SERVICE_USER}/g" rs3mini-bridge.service \
  | sudo tee /etc/systemd/system/rs3mini-bridge.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable rs3mini-bridge
sudo systemctl restart rs3mini-bridge

sleep 2
systemctl is-active rs3mini-bridge
curl -sf "http://127.0.0.1:${PORT:-8787}/health/label" || echo "(health pending — journalctl -u rs3mini-bridge -f)"

echo "→ install done"
