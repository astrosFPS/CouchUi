#!/usr/bin/env bash
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$HOME/.config/systemd/user/couch-ui.service"

echo "==> Installing npm dependencies"
cd "$APP_DIR"
npm install

echo "==> Fixing Electron's chrome-sandbox permissions (requires sudo)"
SANDBOX_BIN="$APP_DIR/node_modules/electron/dist/chrome-sandbox"
if [ -f "$SANDBOX_BIN" ]; then
  sudo chown root:root "$SANDBOX_BIN"
  sudo chmod 4755 "$SANDBOX_BIN"
else
  echo "  (chrome-sandbox not found yet — skipping, will need this after any electron update)"
fi

echo "==> Writing systemd user service ($SERVICE_FILE)"
mkdir -p "$(dirname "$SERVICE_FILE")"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CouchUI (TV-style kiosk)
After=graphical-session.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v npx) electron .
Restart=on-failure
Environment=DISPLAY=:0

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable couch-ui.service

echo ""
echo "Done. The launcher will start automatically at your next graphical login."
echo "To start it right now:   systemctl --user start couch-ui"
echo "To watch logs:           journalctl --user -u couch-ui -f"
echo "To disable autostart:    systemctl --user disable couch-ui"
echo ""
echo "Edit config.json to point tiles at your real app binaries and media path."
