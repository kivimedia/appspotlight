#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# AppSpotlight VPS Setup Script
# Run as: sudo bash setup-vps.sh
# Target: Ubuntu 22.04+ / Debian 12+
# ─────────────────────────────────────────────────────────────

set -euo pipefail

APP_DIR="/opt/appspotlight"
APP_USER="ziv"
SERVICE_NAME="appspotlight-watcher"

echo "══════════════════════════════════════════════"
echo "  AppSpotlight VPS Setup"
echo "══════════════════════════════════════════════"

# 1. System packages
echo ""
echo "▸ Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential python3 libvips-dev

# 2. Node.js 20 LTS
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  echo "▸ Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  echo "▸ Node.js $(node -v) already installed"
fi

# 3. Playwright system deps (for headless Chromium screenshots)
echo "▸ Installing Playwright system dependencies..."
npx -y playwright install-deps chromium 2>/dev/null || true

# 4. Create app directory
echo "▸ Setting up ${APP_DIR}..."
mkdir -p "${APP_DIR}"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}"

# 5. Reminder to copy code
echo ""
echo "══════════════════════════════════════════════"
echo "  System setup complete!"
echo "══════════════════════════════════════════════"
echo ""
echo "Next steps (run as ${APP_USER}):"
echo ""
echo "  1. Copy the appspotlight code to ${APP_DIR}:"
echo "     rsync -av --exclude node_modules --exclude dist \\"
echo "       ./appspotlight/ ${APP_USER}@\$(hostname):${APP_DIR}/"
echo ""
echo "  2. Create .env on the server:"
echo "     cp ${APP_DIR}/.env.example ${APP_DIR}/.env"
echo "     nano ${APP_DIR}/.env  # fill in secrets"
echo ""
echo "  3. Install deps and build:"
echo "     cd ${APP_DIR} && npm ci && npm run build"
echo "     npx playwright install chromium"
echo ""
echo "  4. Install the systemd service:"
echo "     sudo cp ${APP_DIR}/deploy/appspotlight-watcher.service \\"
echo "       /etc/systemd/system/${SERVICE_NAME}.service"
echo "     sudo systemctl daemon-reload"
echo "     sudo systemctl enable ${SERVICE_NAME}"
echo "     sudo systemctl start ${SERVICE_NAME}"
echo ""
echo "  5. Verify:"
echo "     curl http://localhost:3100/health"
echo "     sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  6. Set up GitHub webhook:"
echo "     URL: http://YOUR_VPS_IP:3100/webhook"
echo "     Content type: application/json"
echo "     Secret: (same as GITHUB_WEBHOOK_SECRET in .env)"
echo "     Events: Pushes, Repositories, Releases"
echo ""
