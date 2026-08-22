#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORTABLE_AGENT="$SCRIPT_DIR/openclaw-sync.cjs"
REPO_AGENT="$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd)/apps/openclaw-sync/dist/index.cjs"
AGENT="$PORTABLE_AGENT"
if [ ! -f "$AGENT" ]; then
  AGENT="$REPO_AGENT"
fi

SERVER_URL="${AI_ARCHIVE_SERVER:-https://ai-archive.gyee.tech:18443}"
CONFIG_PATH="${AI_ARCHIVE_SYNC_CONFIG:-$HOME/.config/ai-archive/openclaw-sync.json}"
OPENCLAW_ROOT="${AI_ARCHIVE_OPENCLAW_ROOT:-$HOME/.openclaw}"
CODEX_ROOT="${AI_ARCHIVE_CODEX_ROOT:-$HOME/.codex}"
CLAUDE_CODE_ROOT="${AI_ARCHIVE_CLAUDE_CODE_ROOT:-}"
SAFE_RECENT_DAYS="${AI_ARCHIVE_SAFE_RECENT_DAYS:-14}"
SAFE_MAX_FILES="${AI_ARCHIVE_SAFE_MAX_FILES:-60}"
SAFE_MAX_FILE_MB="${AI_ARCHIVE_SAFE_MAX_FILE_MB:-50}"
SAFE_MAX_MESSAGES="${AI_ARCHIVE_SAFE_MAX_MESSAGES:-12000}"
SAFE_DELAY_MS="${AI_ARCHIVE_SYNC_DELAY_MS:-750}"
LABEL="com.ai-archive.openclaw-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AIArchive"

if [ -z "$CLAUDE_CODE_ROOT" ] && [ -d "$HOME/.claude" ]; then
  CLAUDE_CODE_ROOT="$HOME/.claude"
fi

pause() {
  printf "\nPress Enter to close..."
  read _answer || true
}

require_agent() {
  if [ ! -f "$AGENT" ]; then
    echo "Missing sync agent: $PORTABLE_AGENT"
    echo "Keep AI-Archive-Sync.command and openclaw-sync.cjs in the same extracted folder."
    exit 1
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found. Install Node.js 22 or newer first."
    echo "Download: https://nodejs.org/"
    exit 1
  fi
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Node.js 22 or newer is required. Current version: $(node -v)"
    exit 1
  fi
}

pair_if_needed() {
  if [ -f "$CONFIG_PATH" ]; then
    echo "Existing pairing config found; pairing step skipped."
    return 1
  fi

  echo
  echo "First run: create an OpenClaw/Codex sync pairing code in the web console."
  printf "Pairing code: "
  read PAIR_CODE
  if [ -z "$PAIR_CODE" ]; then
    echo "Pairing code is required on first run."
    exit 1
  fi

  PAIR_ARGS="pair --server $SERVER_URL --code $PAIR_CODE --openclaw-root $OPENCLAW_ROOT --codex-root $CODEX_ROOT"
  if [ -n "$CLAUDE_CODE_ROOT" ]; then
    node "$AGENT" pair --server "$SERVER_URL" --code "$PAIR_CODE" --openclaw-root "$OPENCLAW_ROOT" --codex-root "$CODEX_ROOT" --claude-code-root "$CLAUDE_CODE_ROOT"
  else
    node "$AGENT" pair --server "$SERVER_URL" --code "$PAIR_CODE" --openclaw-root "$OPENCLAW_ROOT" --codex-root "$CODEX_ROOT"
  fi
  return 0
}

xml_escape() {
  printf "%s" "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

install_background() {
  require_agent
  require_node
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "Pairing config is missing: $CONFIG_PATH"
    pair_if_needed
  fi

  NODE_BIN="$(command -v node)"
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

  NODE_XML="$(xml_escape "$NODE_BIN")"
  AGENT_XML="$(xml_escape "$AGENT")"
  CONFIG_XML="$(xml_escape "$CONFIG_PATH")"
  LOG_XML="$(xml_escape "$LOG_DIR")"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_XML</string>
      <string>$AGENT_XML</string>
      <string>run</string>
      <string>--recent-days</string>
      <string>$SAFE_RECENT_DAYS</string>
      <string>--max-files</string>
      <string>$SAFE_MAX_FILES</string>
      <string>--max-file-mb</string>
      <string>$SAFE_MAX_FILE_MB</string>
      <string>--max-messages</string>
      <string>$SAFE_MAX_MESSAGES</string>
      <string>--delay-ms</string>
      <string>$SAFE_DELAY_MS</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AI_ARCHIVE_SYNC_CONFIG</key>
      <string>$CONFIG_XML</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$LOG_XML/openclaw-sync.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_XML/openclaw-sync.error.log</string>
  </dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/$LABEL"
  echo "Installed and started background sync."
  echo "Logs: $LOG_DIR"
}

uninstall_background() {
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
  fi
  echo "Uninstalled background sync."
}

run_foreground() {
  require_agent
  require_node
  node "$AGENT" run --recent-days "$SAFE_RECENT_DAYS" --max-files "$SAFE_MAX_FILES" --max-file-mb "$SAFE_MAX_FILE_MB" --max-messages "$SAFE_MAX_MESSAGES" --delay-ms "$SAFE_DELAY_MS"
}

rebuild_once() {
  require_agent
  require_node
  node "$AGENT" rebuild --recent-days "$SAFE_RECENT_DAYS" --max-files "$SAFE_MAX_FILES" --max-file-mb "$SAFE_MAX_FILE_MB" --max-messages "$SAFE_MAX_MESSAGES" --delay-ms "$SAFE_DELAY_MS"
}

print_header() {
  echo
  echo "知言归藏 - macOS 本地同步"
  echo "Folder : $SCRIPT_DIR"
  echo "Server : $SERVER_URL"
  echo "Codex  : $CODEX_ROOT"
  echo "Config : $CONFIG_PATH"
  echo
}

main_menu() {
  echo "Choose an action:"
  echo "  1) Install or restart background sync"
  echo "  2) Run sync in this Terminal window"
  echo "  3) Import recent history once"
  echo "  4) Uninstall background sync"
  echo "  Q) Quit"
  printf "Selection [1]: "
  read choice
  case "${choice:-1}" in
    1) install_background ;;
    2) run_foreground ;;
    3) rebuild_once ;;
    4) uninstall_background ;;
    q|Q) exit 0 ;;
    *) echo "Unknown selection."; exit 1 ;;
  esac
}

COMMAND="${1:-menu}"
require_agent
require_node

case "$COMMAND" in
  install|install-background|background)
    pair_if_needed || true
    install_background
    ;;
  uninstall|uninstall-background)
    uninstall_background
    ;;
  run|watch)
    pair_if_needed || true
    run_foreground
    ;;
  rebuild|once|rebuild-only)
    pair_if_needed || true
    rebuild_once
    ;;
  menu)
    print_header
    if pair_if_needed; then
      echo
      printf "Install background sync now? [Y/n]: "
      read answer
      case "${answer:-Y}" in
        y|Y|yes|YES) install_background ;;
        *) rebuild_once; run_foreground ;;
      esac
    else
      main_menu
    fi
    ;;
  *)
    echo "Usage: AI-Archive-Sync.command [install|uninstall|run|rebuild]"
    exit 1
    ;;
esac

pause
