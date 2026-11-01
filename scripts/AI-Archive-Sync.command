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
export AI_ARCHIVE_SYNC_CONFIG="$CONFIG_PATH"
OPENCLAW_ROOT="${AI_ARCHIVE_OPENCLAW_ROOT:-$HOME/.openclaw}"
CODEX_ROOT="${AI_ARCHIVE_CODEX_ROOT:-$HOME/.codex}"
CLAUDE_CODE_ROOT="${AI_ARCHIVE_CLAUDE_CODE_ROOT:-}"
GROK_BUILD_ROOT="${AI_ARCHIVE_GROK_BUILD_ROOT:-${GROK_HOME:-$HOME/.grok}}"
if [ -d "$GROK_BUILD_ROOT" ]; then
  export AI_ARCHIVE_GROK_BUILD_ROOT="$GROK_BUILD_ROOT"
fi
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

pair_now() {
  if [ -f "$CONFIG_PATH" ]; then
    preserve_background_limits || return $?
  fi
  echo
  echo "Create a new OpenClaw/Codex sync pairing code in the web console."
  printf "Pairing code: "
  if ! read -r PAIR_CODE; then
    echo "Unable to read a pairing code."
    return 2
  fi
  if [ -z "$PAIR_CODE" ]; then
    echo "Pairing code is required."
    return 2
  fi

  set -- pair --code "$PAIR_CODE"
  if [ -f "$CONFIG_PATH" ]; then
    set -- "$@" --preserve-config
    if [ "${AI_ARCHIVE_SERVER+x}" = x ]; then
      set -- "$@" --server "$SERVER_URL"
    fi
  else
    set -- "$@" --server "$SERVER_URL" --openclaw-root "$OPENCLAW_ROOT" --codex-root "$CODEX_ROOT"
    if [ -n "$CLAUDE_CODE_ROOT" ]; then
      set -- "$@" --claude-code-root "$CLAUDE_CODE_ROOT"
    fi
    if [ -d "$GROK_BUILD_ROOT" ]; then
      set -- "$@" --grok-build-root "$GROK_BUILD_ROOT"
    fi
  fi

  BACKGROUND_WAS_LOADED=0
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    if ! launchctl bootout "gui/$(id -u)/$LABEL"; then
      echo "Could not stop background sync. Pairing was cancelled."
      return 2
    fi
    BACKGROUND_WAS_LOADED=1
  fi
  if ! node "$AGENT" "$@"; then
    echo "Pairing failed. Background sync has not been restarted."
    return 2
  fi
  if [ "$BACKGROUND_WAS_LOADED" -eq 1 ]; then
    if ! install_background; then
      echo "Pairing succeeded, but background sync could not be restarted."
      return 2
    fi
  else
    echo "Pairing succeeded. Start sync with launcher option 1 or 2, or run:"
    printf '  "%s" run\n' "$SCRIPT_DIR/AI-Archive-Sync.command"
    printf '  "%s" install\n' "$SCRIPT_DIR/AI-Archive-Sync.command"
  fi
  return 0
}

preserve_background_limit() {
  case " $PRESERVED_LIMIT_FLAGS " in
    *" $1 "*) return 0 ;;
  esac
  PRESERVED_LIMIT_FLAGS="$PRESERVED_LIMIT_FLAGS $1"
  case "$1" in
    --recent-days)
      if [ "${AI_ARCHIVE_SAFE_RECENT_DAYS+x}" != x ]; then SAFE_RECENT_DAYS="$2"; fi ;;
    --max-files)
      if [ "${AI_ARCHIVE_SAFE_MAX_FILES+x}" != x ]; then SAFE_MAX_FILES="$2"; fi ;;
    --max-file-mb)
      if [ "${AI_ARCHIVE_SAFE_MAX_FILE_MB+x}" != x ]; then SAFE_MAX_FILE_MB="$2"; fi ;;
    --max-messages)
      if [ "${AI_ARCHIVE_SAFE_MAX_MESSAGES+x}" != x ]; then SAFE_MAX_MESSAGES="$2"; fi ;;
    --delay-ms)
      if [ "${AI_ARCHIVE_SYNC_DELAY_MS+x}" != x ]; then SAFE_DELAY_MS="$2"; fi ;;
  esac
}

preserve_background_limits() {
  if [ ! -f "$PLIST" ]; then return 0; fi
  PLIST_BUDDY="$(command -v PlistBuddy 2>/dev/null || true)"
  if [ -z "$PLIST_BUDDY" ]; then PLIST_BUDDY=/usr/libexec/PlistBuddy; fi
  if ! PLIST_ARGUMENTS="$("$PLIST_BUDDY" -c 'Print :ProgramArguments' "$PLIST" 2>/dev/null)"; then
    echo "Cannot read installed background sync arguments. Repair cancelled to preserve its safety settings."
    return 2
  fi
  case "$PLIST_ARGUMENTS" in
    'Array {'*) ;;
    *) echo "Installed ProgramArguments is not an array. Repair cancelled."; return 2 ;;
  esac
  PRESERVED_LIMIT_FLAGS=""
  PLIST_INDEX=0
  while PLIST_ARGUMENT="$("$PLIST_BUDDY" -c "Print :ProgramArguments:$PLIST_INDEX" "$PLIST" 2>/dev/null)"; do
    case "$PLIST_ARGUMENT" in
      --recent-days|--max-files|--max-file-mb|--max-messages|--delay-ms)
        PLIST_INDEX=$((PLIST_INDEX + 1))
        if ! PLIST_VALUE="$("$PLIST_BUDDY" -c "Print :ProgramArguments:$PLIST_INDEX" "$PLIST" 2>/dev/null)"; then
          echo "Installed $PLIST_ARGUMENT has no value. Repair cancelled."
          return 2
        fi
        preserve_background_limit "$PLIST_ARGUMENT" "$PLIST_VALUE"
        ;;
      --recent-days=*|--max-files=*|--max-file-mb=*|--max-messages=*|--delay-ms=*)
        preserve_background_limit "${PLIST_ARGUMENT%%=*}" "${PLIST_ARGUMENT#*=}"
        ;;
    esac
    PLIST_INDEX=$((PLIST_INDEX + 1))
  done
}

pair_if_needed() {
  if [ -f "$CONFIG_PATH" ]; then
    echo "Existing pairing config found; pairing step skipped."
    return 1
  fi
  # This function is called from conditionals, where set -e does not apply.
  # Keep 1 reserved for an existing config and report pairing failures as 2.
  if pair_now; then
    return 0
  fi
  return 2
}

ensure_paired() {
  if pair_if_needed; then
    return 0
  else
    PAIR_STATUS=$?
    if [ "$PAIR_STATUS" -eq 1 ]; then
      return 0
    fi
    return "$PAIR_STATUS"
  fi
}

xml_escape() {
  printf "%s" "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

install_background() {
  require_agent
  require_node
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "Pairing config is missing: $CONFIG_PATH"
    ensure_paired || return $?
  fi

  NODE_BIN="$(command -v node)" || return $?
  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" || return $?

  NODE_XML="$(xml_escape "$NODE_BIN")" || return $?
  AGENT_XML="$(xml_escape "$AGENT")" || return $?
  CONFIG_XML="$(xml_escape "$CONFIG_PATH")" || return $?
  LOG_XML="$(xml_escape "$LOG_DIR")" || return $?
  RECENT_XML="$(xml_escape "$SAFE_RECENT_DAYS")" || return $?
  MAX_FILES_XML="$(xml_escape "$SAFE_MAX_FILES")" || return $?
  MAX_FILE_MB_XML="$(xml_escape "$SAFE_MAX_FILE_MB")" || return $?
  MAX_MESSAGES_XML="$(xml_escape "$SAFE_MAX_MESSAGES")" || return $?
  DELAY_XML="$(xml_escape "$SAFE_DELAY_MS")" || return $?
  GROK_ENV_XML="$(xml_escape "${AI_ARCHIVE_GROK_BUILD_ROOT:-}")" || return $?

  cat > "$PLIST" <<EOF || return $?
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
      <string>--auth-revoked-exit-success</string>
      <string>--recent-days</string>
      <string>$RECENT_XML</string>
      <string>--max-files</string>
      <string>$MAX_FILES_XML</string>
      <string>--max-file-mb</string>
      <string>$MAX_FILE_MB_XML</string>
      <string>--max-messages</string>
      <string>$MAX_MESSAGES_XML</string>
      <string>--delay-ms</string>
      <string>$DELAY_XML</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AI_ARCHIVE_SYNC_CONFIG</key>
      <string>$CONFIG_XML</string>
      <key>AI_ARCHIVE_GROK_BUILD_ROOT</key>
      <string>$GROK_ENV_XML</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
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
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || return $?
  launchctl enable "gui/$(id -u)/$LABEL" || return $?
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
  run_sync run
}

rebuild_once() {
  require_agent
  require_node
  run_sync rebuild
}

run_sync() {
  if node "$AGENT" "$1" --recent-days "$SAFE_RECENT_DAYS" --max-files "$SAFE_MAX_FILES" --max-file-mb "$SAFE_MAX_FILE_MB" --max-messages "$SAFE_MAX_MESSAGES" --delay-ms "$SAFE_DELAY_MS"; then
    return 0
  else
    SYNC_STATUS=$?
    if [ "$SYNC_STATUS" -eq 3 ]; then
      echo
      echo "Device authorization was revoked. Create a new pairing code, then run:"
      printf '  "%s" pair\n' "$SCRIPT_DIR/AI-Archive-Sync.command"
      echo "You can also reopen this launcher and choose option 5."
    fi
    return "$SYNC_STATUS"
  fi
}

print_header() {
  echo
  echo "知言归藏 - macOS 本地同步"
  echo "Folder : $SCRIPT_DIR"
  echo "Server : $SERVER_URL"
  echo "Codex  : $CODEX_ROOT"
  echo "Grok Build (CLI/Desktop): $GROK_BUILD_ROOT"
  echo "Config : $CONFIG_PATH"
  echo
}

main_menu() {
  echo "Choose an action:"
  echo "  1) Install or restart background sync"
  echo "  2) Run sync in this Terminal window"
  echo "  3) Import recent history once"
  echo "  4) Uninstall background sync"
  echo "  5) Pair again / repair device authorization"
  echo "  Q) Quit"
  printf "Selection [1]: "
  read choice
  case "${choice:-1}" in
    1) install_background ;;
    2) run_foreground ;;
    3) rebuild_once ;;
    4) uninstall_background ;;
    5) pair_now ;;
    q|Q) trap - 0; exit 0 ;;
    *) echo "Unknown selection."; exit 1 ;;
  esac
}

COMMAND="${1:-menu}"
finish() {
  EXIT_STATUS=$?
  trap - 0
  if [ "$EXIT_STATUS" -ne 0 ]; then
    echo
    echo "Action failed (exit $EXIT_STATUS). Review the error above."
  fi
  pause
  exit "$EXIT_STATUS"
}
trap finish 0
require_agent
require_node

case "$COMMAND" in
  install|install-background|background)
    ensure_paired
    install_background
    ;;
  uninstall|uninstall-background)
    uninstall_background
    ;;
  run|watch)
    ensure_paired
    run_foreground
    ;;
  rebuild|once|rebuild-only)
    ensure_paired
    rebuild_once
    ;;
  pair|re-pair|repair)
    pair_now
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
      PAIR_STATUS=$?
      if [ "$PAIR_STATUS" -ne 1 ]; then
        exit "$PAIR_STATUS"
      fi
      main_menu
    fi
    ;;
  *)
    echo "Usage: AI-Archive-Sync.command [install|uninstall|run|rebuild|pair]"
    exit 1
    ;;
esac
