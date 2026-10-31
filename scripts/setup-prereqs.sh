#!/usr/bin/env bash
# Linux prerequisites for rs3mini-bridge. Idempotent — safe to re-run.
# Called by scripts/install.sh on the bridge host.
#
# Keep this LEAN on Pi Zero 2 W: do NOT apt-install debian nodejs+npm+build-essential
# in one shot over Wi-Fi (hangs for 10+ minutes / leaves dpkg half-configured).
# Prefer NodeSource Node 20 only; add build tools only if npm ci needs them.

set -euo pipefail

MIN_NODE_MAJOR="${MIN_NODE_MAJOR:-20}"
DEPLOY_USER="${DEPLOY_USER:-$(whoami)}"

export DEBIAN_FRONTEND=noninteractive

echo "→ fix any interrupted apt/dpkg"
sudo dpkg --configure -a 2>/dev/null || true
sudo apt-get -f install -y -qq 2>/dev/null || true

echo "→ apt: bluetooth stack + caps (small)"
sudo apt-get update -qq
sudo apt-get install -y -qq bluetooth bluez libcap2-bin rfkill curl ca-certificates

sudo rfkill unblock bluetooth 2>/dev/null || true
sudo bluetoothctl power on 2>/dev/null || true
sudo hciconfig hci0 up 2>/dev/null || true

need_node() {
  command -v node >/dev/null 2>&1 || return 0
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [[ "$major" -lt "$MIN_NODE_MAJOR" ]]
}

install_nodesource() {
  echo "→ installing NodeSource ${MIN_NODE_MAJOR}.x (single nodejs package — not debian npm metapackage)"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y -qq nodejs
}

if ! command -v node >/dev/null 2>&1 || need_node; then
  install_nodesource
fi

if need_node; then
  echo "ERROR: node $(node -v 2>/dev/null || echo missing) — need >= ${MIN_NODE_MAJOR}" >&2
  exit 1
fi

NODE_BIN="$(readlink -f "$(command -v node)")"
sudo setcap cap_net_raw,cap_net_admin+eip "$NODE_BIN" 2>/dev/null || true

sudo usermod -aG bluetooth "$DEPLOY_USER" 2>/dev/null || true

echo "→ node $(node -v) npm $(npm -v)"

for cmd in bluetoothctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: missing $cmd after apt install" >&2
    exit 1
  fi
done

if ! groups "$DEPLOY_USER" | grep -q bluetooth; then
  echo "WARN: $DEPLOY_USER not in bluetooth group yet — reboot or re-login may be required"
fi

echo "→ prereqs OK"
echo "  (build-essential NOT installed by default — run: sudo apt-get install -y build-essential python3 libudev-dev"
echo "   only if npm ci fails compiling native modules)"
