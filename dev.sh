#!/usr/bin/env bash
# Serve JetLens locally and expose it over HTTPS for testing on a real phone.
#
# The camera and motion APIs only work in a secure context. localhost qualifies,
# but a LAN address like http://192.168.1.5:8765 does not -- the phone will deny
# the camera without a visible error. Hence the tunnel.
#
# Usage: ./dev.sh
# Requires: cloudflared  (brew install cloudflared)

set -euo pipefail

PORT=8765

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared not found. Install it with:  brew install cloudflared" >&2
  exit 1
fi

cd "$(dirname "$0")"

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "Serving $(pwd) on :$PORT"
echo "Starting tunnel -- open the https://*.trycloudflare.com URL below on your phone."
echo

# Quick tunnels need no account. The hostname is random and changes each run,
# which is why the Worker's ALLOWED_ORIGINS is currently left open.
cloudflared tunnel --url "http://localhost:$PORT"
