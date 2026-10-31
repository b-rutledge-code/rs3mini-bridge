#!/usr/bin/env bash
# Block rs3mini-bridge start until Wi‑Fi has IPv4.
#
# Pi Zero 2 W: Wi‑Fi + Bluetooth share one radio. If noble/BLE starts before
# NetworkManager associates, wlan often never joins (green LED, offline until reflash).
# Fresh flash works; bridge install enables this service on boot — race appears after reboot.
#
# Env (optional, from /etc/rs3mini-bridge.env):
#   WIFI_IFACE=wlan0          # or wlan1 when Alfa is the STA
#   WIFI_WAIT_TIMEOUT_SEC=120

set -euo pipefail

IFACE="${WIFI_IFACE:-}"
TIMEOUT="${WIFI_WAIT_TIMEOUT_SEC:-120}"
deadline=$((SECONDS + TIMEOUT))

has_ip() {
  local dev=$1
  ip -4 -o addr show dev "$dev" scope global 2>/dev/null | grep -q ' inet '
}

while (( SECONDS < deadline )); do
  if [[ -n "$IFACE" ]]; then
    if has_ip "$IFACE"; then
      echo "wait-wifi: $IFACE has IPv4"
      exit 0
    fi
  else
    for d in wlan0 wlan1; do
      if has_ip "$d"; then
        echo "wait-wifi: $d has IPv4"
        exit 0
      fi
    done
  fi
  sleep 2
done

echo "wait-wifi: no Wi‑Fi IPv4 within ${TIMEOUT}s (iface=${IFACE:-wlan0|wlan1})" >&2
exit 1
