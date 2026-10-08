#!/usr/bin/env bash
# Serve JetLens locally and expose it over HTTPS for testing on a real phone.
#
# The camera and motion APIs only work in a secure context. localhost qualifies,
# but a LAN address like http://192.168.1.5:8765 does not -- the phone will deny
# the camera without a visible error. Hence the tunnel.
#
# Netlify now serves dist/, not the repo root, so a build has to run before the
# server starts and again on every edit -- otherwise you would be testing the last
# build against the source you just changed. build.mjs --watch handles both.
#
# Usage: ./dev.sh
# Requires: cloudflared  (brew install cloudflared)
#           netlify      (npm i -g netlify-cli)
#           npm install  (once, for the build's devDependencies)

set -euo pipefail

PORT=8765

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared not found. Install it with:  brew install cloudflared" >&2
  exit 1
fi

if ! command -v netlify >/dev/null; then
  echo "netlify not found. Install it with:  npm i -g netlify-cli" >&2
  exit 1
fi

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing build dependencies..."
  npm install --no-fund --no-audit
fi

# Build once up front, then keep rebuilding as index.html is edited. Started
# before netlify dev so that dist/ exists by the time the server binds.
node build.mjs --watch &
BUILD_PID=$!
trap 'kill $BUILD_PID 2>/dev/null || true' EXIT

# `netlify dev` rather than a plain static server: the plane feed goes through a
# function now (netlify/functions/planes.mjs), and python's http.server would just
# 404 the /api/planes call, leaving the sky permanently empty.
netlify dev --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID $BUILD_PID 2>/dev/null || true' EXIT

echo "Serving $(pwd) on :$PORT -- waiting for netlify dev to bind..."

# The tunnel must not start before netlify dev is listening, or cloudflared
# publishes a URL that 502s until the server catches up.
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT" >/dev/null 2>&1 && break
  sleep 1
done

echo "Starting tunnel -- open the https://*.trycloudflare.com URL below on your phone."
echo

# Quick tunnels need no account. The hostname is random and changes each run,
# which is why the Worker's ALLOWED_ORIGINS is currently left open.
cloudflared tunnel --url "http://localhost:$PORT"
