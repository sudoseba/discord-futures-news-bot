#!/usr/bin/env bash
#
# Install (or refresh) the Web Dashboard as a systemd service.
# Safe to re-run.
#
#   bash web/deploy/install-web-service.sh            # install + enable on boot
#   bash web/deploy/install-web-service.sh --start    # also start it now
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$WEB_DIR/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-discord-web-dashboard}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$(id -un)}}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
TEMPLATE="$SCRIPT_DIR/discord-web-dashboard.service"
DEST="/etc/systemd/system/${SERVICE_NAME}.service"

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

echo "==> Web Dashboard — systemd installer"
echo "    unit    : ${SERVICE_NAME}.service"
echo "    user    : ${RUN_USER}"
echo "    workdir : ${WEB_DIR}"
echo "    node    : ${NODE_BIN}"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Install Node.js >= 20 first." >&2
  exit 1
fi
if [ ! -d "$WEB_DIR/node_modules" ]; then
  echo "WARNING: $WEB_DIR/node_modules is missing — run 'cd web && npm ci --omit=dev' before starting." >&2
fi
if [ ! -f "$WEB_DIR/.env" ]; then
  echo "WARNING: $WEB_DIR/.env is missing — copy .env.example to .env and set SESSION_SECRET + admins." >&2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed -e "s|__USER__|${RUN_USER}|g" \
    -e "s|__DIR__|${REPO_DIR}|g" \
    -e "s|__NODE__|${NODE_BIN}|g" \
    "$TEMPLATE" > "$tmp"

$SUDO cp "$tmp" "$DEST"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null
echo "==> Installed and enabled on boot."

if [ "${1:-}" = "--start" ]; then
  $SUDO systemctl restart "$SERVICE_NAME"
  $SUDO systemctl --no-pager -n 12 status "$SERVICE_NAME" || true
else
  echo "    Start:  ${SUDO} systemctl start ${SERVICE_NAME}"
fi
echo "    Logs :  journalctl -u ${SERVICE_NAME} -f"
