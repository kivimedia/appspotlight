#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# AppSpotlight Deploy Script
# Syncs code to VPS and restarts the watcher service.
#
# Usage: bash deploy/deploy.sh [VPS_HOST]
# Example: bash deploy/deploy.sh ziv@157.180.37.69
# ─────────────────────────────────────────────────────────────

set -euo pipefail

VPS_HOST="${1:-ziv@157.180.37.69}"
APP_DIR="/opt/appspotlight"
SERVICE_NAME="appspotlight-watcher"

echo "══════════════════════════════════════════════"
echo "  Deploying AppSpotlight to ${VPS_HOST}"
echo "══════════════════════════════════════════════"

# 1. Sync code (excludes node_modules, dist, .env, git)
echo "▸ Syncing code..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.git' \
  --exclude '*.log' \
  ./ "${VPS_HOST}:${APP_DIR}/"

# 2. Install deps & build on remote
echo "▸ Installing deps and building..."
ssh "${VPS_HOST}" "cd ${APP_DIR} && npm ci --production=false && npm run build"

# 3. Restart service
echo "▸ Restarting service..."
ssh "${VPS_HOST}" "sudo systemctl restart ${SERVICE_NAME}"

# 4. Health check
echo "▸ Waiting 3s for startup..."
sleep 3
ssh "${VPS_HOST}" "curl -sf http://localhost:3100/health || echo 'Health check failed!'"

echo ""
echo "▸ Deploy complete! Check logs with:"
echo "  ssh ${VPS_HOST} 'sudo journalctl -u ${SERVICE_NAME} -f'"
