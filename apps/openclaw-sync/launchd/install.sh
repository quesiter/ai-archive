#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BIN=${NODE_BIN:-$(command -v node)}
CONFIG_PATH=${AI_ARCHIVE_SYNC_CONFIG:-"$HOME/.config/ai-archive/openclaw-sync.json"}
LOG_DIR="$HOME/Library/Logs/AIArchive"
PLIST="$HOME/Library/LaunchAgents/com.ai-archive.openclaw-sync.plist"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__SCRIPT__|$APP_DIR/dist/index.cjs|g" \
  -e "s|__CONFIG__|$CONFIG_PATH|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$SCRIPT_DIR/com.ai-archive.openclaw-sync.plist.template" > "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.ai-archive.openclaw-sync"
echo "Installed and started: $PLIST"
