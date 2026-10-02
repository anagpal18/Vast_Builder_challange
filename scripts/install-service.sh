#!/usr/bin/env bash
# Install + start a systemd service that keeps the API up across reboots (Linux VM).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"; USER_NAME="$(id -un)"
sed -e "s#@ROOT@#$ROOT#g" -e "s#@USER@#$USER_NAME#g" deploy/almost.service | sudo tee /etc/systemd/system/almost.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now almost
sudo systemctl restart almost
sleep 2; systemctl --no-pager status almost | head -5
echo "logs: journalctl -u almost -f"
