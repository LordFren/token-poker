#!/usr/bin/env bash
# Build & (re)start token-poker on the server. Idempotent — safe to re-run for
# every deploy. Run as the 'poker' user from /opt/token-poker:
#   cd /opt/token-poker && ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest"
git pull --ff-only

echo "==> Installing deps (clean, reproducible)"
npm ci

echo "==> Building web + server"
npm run build

echo "==> Syncing built static site to web root"
sudo rsync -a --delete web/dist/ /var/www/token-poker/

echo "==> Restarting service"
sudo systemctl restart token-poker

echo "==> Health check"
sleep 1
curl -fsS http://127.0.0.1:3000/healthz && echo " OK" || { echo "HEALTH CHECK FAILED"; exit 1; }

echo "==> Done."
