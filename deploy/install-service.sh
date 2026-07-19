#!/usr/bin/env bash
#
# Install (or refresh) the Discord News Bot as a systemd service.
# Safe to re-run — it just re-renders and reloads the unit.
#
# Usage:
#     bash deploy/install-service.sh            # install + enable on boot
#     bash deploy/install-service.sh --start    # also start it now
#
# Override the unit name or run-as user if you want:
#     SERVICE_NAME=my-bot RUN_USER=pi bash deploy/install-service.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-discord-news-bot}"
# When run under sudo, $USER is "root" — prefer the invoking user.
RUN_USER="${RUN_USER:-${SUDO_USER:-$(id -un)}}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
TEMPLATE="$SCRIPT_DIR/${SERVICE_NAME}.service"
[ -f "$TEMPLATE" ] || TEMPLATE="$SCRIPT_DIR/discord-news-bot.service"
DEST="/etc/systemd/system/${SERVICE_NAME}.service"

# sudo only if we aren't already root.
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

echo "==> Discord News Bot — systemd installer"
echo "    unit    : ${SERVICE_NAME}.service"
echo "    user    : ${RUN_USER}"
echo "    workdir : ${REPO_DIR}"
echo "    node    : ${NODE_BIN}"
echo "    dest    : ${DEST}"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Install Node.js >= 20 first (see deploy/README.md)." >&2
  exit 1
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: unit template not found: $TEMPLATE" >&2
  exit 1
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
  echo "==> Started. Recent status:"
  $SUDO systemctl --no-pager -n 10 status "$SERVICE_NAME" || true
else
  echo "    Start it now with:  ${SUDO} systemctl start ${SERVICE_NAME}"
  echo "    Or use the panel :  node admin-panel.js   (menu -> Bot control)"
fi

echo "    Follow logs      :  journalctl -u ${SERVICE_NAME} -f"
