#!/usr/bin/env bash
# Merge site.env bridge-runtime keys into /etc/rs3mini-bridge.env.
# Deploy / install run this on the bridge host. site.env is gitignored.
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/rs3mini-bridge}"
SITE="${SITE_ENV:-$INSTALL_ROOT/site.env}"
TARGET="${BRIDGE_ENV:-/etc/rs3mini-bridge.env}"
EXAMPLE="$INSTALL_ROOT/rs3mini-bridge.env.example"

# Keys allowed into the systemd EnvironmentFile (not deploy passwords / notes).
ALLOW_RE='^(GIMBAL_NAME_RE|PORT|RECONNECT_MS|STARTUP_GUARD_MS|MOVE_HOLD_MS|HOLD_PROMOTE_MS|NUDGE_MS|RELEASE_NEUTRAL_FRAMES|MOVE_STICK_SCALE|MAX_MOVE_MS|LOG_LEVEL|WIFI_IFACE|WIFI_POLL_MS|WIFI_WAIT_TIMEOUT_SEC|BRIDGE_TOKEN|CONNECT_TIMEOUT_MS|CONNECT_TOTAL_MS|CONNECT_STALE_MS|CONNECT_DELAY_MS|GATT_DISCOVER_MS|GATT_DISCOVER_RETRIES|PAIRING_WRITE_NO_RESPONSE|PAIRING_WRITE_MS|PAIRING_DELAY_MS)='

if [[ ! -f "$SITE" ]]; then
  echo "→ no site.env at $SITE — skipping apply"
  exit 0
fi

if [[ ! -f "$TARGET" ]]; then
  if [[ -f "$EXAMPLE" ]]; then
    sudo cp "$EXAMPLE" "$TARGET"
    sudo chmod 600 "$TARGET"
    echo "→ created $TARGET from example"
  else
    echo "ERROR: missing $TARGET and no example" >&2
    exit 1
  fi
fi

tmp="$(mktemp)"
# keep existing lines whose keys are not overridden by site.env
site_keys="$(grep -E "$ALLOW_RE" "$SITE" | sed 's/=.*//' | sort -u || true)"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line// }" ]]; then
    printf '%s\n' "$line" >>"$tmp"
    continue
  fi
  key="${line%%=*}"
  if printf '%s\n' "$site_keys" | grep -qx "$key"; then
    continue
  fi
  printf '%s\n' "$line" >>"$tmp"
done <"$TARGET"

{
  echo ""
  echo "# --- applied from site.env ($(date -u +%Y-%m-%dT%H:%MZ)) ---"
  grep -E "$ALLOW_RE" "$SITE" || true
} >>"$tmp"

sudo cp "$tmp" "$TARGET"
sudo chmod 600 "$TARGET"
rm -f "$tmp"
echo "→ applied site.env runtime keys → $TARGET"
