#!/usr/bin/env bash
# Installs the strategy-lab archiver as a systemd timer (every 2 min, catch-up on boot).
# Run from the strategy-lab folder:  sudo bash deploy/linux/install-systemd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "node not found in PATH"; exit 1; }

UNIT_DIR=/etc/systemd/system
SERVICE=strategy-lab-archiver.service
TIMER=strategy-lab-archiver.timer

echo "root : $ROOT"
echo "node : $NODE"

if [ ! -f "$ROOT/.env" ]; then
  echo "WARNING: $ROOT/.env missing. Copy .env.example to .env and set ARCHIVE_ENABLED=true."
fi

# Substitute paths into the unit file and install.
sed -e "s#__ROOT__#${ROOT}#g" -e "s#__NODE__#${NODE}#g" \
    "$ROOT/deploy/linux/$SERVICE" | sudo tee "$UNIT_DIR/$SERVICE" >/dev/null
sudo cp "$ROOT/deploy/linux/$TIMER" "$UNIT_DIR/$TIMER"

sudo systemctl daemon-reload
sudo systemctl enable --now "$TIMER"

echo
echo "✅ Installed. Status:"
systemctl status "$TIMER" --no-pager || true
echo
echo "Run one pass now : sudo systemctl start $SERVICE"
echo "Logs             : journalctl -u $SERVICE -f"
echo "Verify coverage  : cd $ROOT && npm run health"
echo "Uninstall        : sudo systemctl disable --now $TIMER && sudo rm $UNIT_DIR/$SERVICE $UNIT_DIR/$TIMER && sudo systemctl daemon-reload"
