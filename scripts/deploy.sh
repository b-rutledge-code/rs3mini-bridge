#!/usr/bin/env bash
# Push rs3mini-bridge to a Pi (or other Linux host) and run install.sh.
# Requires SSH key auth. No secrets in repo.
#
# Config: copy site.env.example → site.env (gitignored), then:
#   bash scripts/deploy.sh
#
# Override any key on the CLI:
#   PI_HOST=<bridge-lan-ip> bash scripts/deploy.sh
#
# First install or OS refresh (apt, setcap, journald):
#   FULL_INSTALL=1 bash scripts/deploy.sh
#
# Password sudo (typical home Pi): use repo .local/deploy-bridge.py instead.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Prefer site.env; fall back to streaming-repo .local (legacy).
SITE_ENV="$ROOT/site.env"
LOCAL_ENV="$ROOT/../.local/pi-bridge.env"
if [[ -f "$SITE_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SITE_ENV"
  set +a
elif [[ -f "$LOCAL_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_ENV"
  set +a
fi

: "${PI_HOST:?set PI_HOST in site.env (or export PI_HOST)}"
PI_USER="${PI_USER:-pi}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/rs3mini-bridge}"

# Default: code-only (rsync + npm ci + restart). FULL_INSTALL=1 runs apt/prereqs too.
SKIP_PREREQS=1
if [[ "${FULL_INSTALL:-0}" == "1" ]]; then
  SKIP_PREREQS=0
fi

chmod +x "$ROOT/scripts/"*.sh 2>/dev/null || true

rsync -avz --delete \
  --exclude node_modules --exclude .git \
  "$ROOT/" "${PI_USER}@${PI_HOST}:${INSTALL_ROOT}/"

ssh "${PI_USER}@${PI_HOST}" \
  "INSTALL_ROOT=${INSTALL_ROOT} SKIP_PREREQS=${SKIP_PREREQS} bash ${INSTALL_ROOT}/scripts/install.sh"
