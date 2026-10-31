#!/usr/bin/env bash
# Install systemd-journald retention drop-in (3 days persistent). Idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DROPIN_DIR=/etc/systemd/journald.conf.d
DROPIN="$DROPIN_DIR/99-gimbal-bridge-retention.conf"

sudo mkdir -p "$DROPIN_DIR"
sudo cp "$ROOT/journald-retention.conf" "$DROPIN"
sudo chmod 644 "$DROPIN"

# Ensure persistent journal directory exists before restart.
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal 2>/dev/null || true

sudo systemctl restart systemd-journald

# Migrate any volatile logs into /var/log/journal when switching to persistent.
sudo journalctl --flush 2>/dev/null || true

echo "→ journald retention: $(grep -E '^MaxRetentionSec|^Storage' "$DROPIN" | tr '\n' ' ')"
journalctl --disk-usage 2>/dev/null || true
