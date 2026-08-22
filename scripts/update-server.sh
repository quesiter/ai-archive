#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
知言归藏 server update

Usage:
  sh scripts/update-server.sh
  sh scripts/update-server.sh /volume1/docker/ai-conversation-archive/ai-conversation-archive-nas-V2.1.1-clean-install.tar.gz

Environment:
  APP_ROOT=/volume1/docker/ai-conversation-archive
  SOURCE_DIR=/volume1/docker/ai-conversation-archive/source
  BACKUP_ROOT=/volume1/backup/ai-conversation-archive
  SKIP_BACKUP=1
  ALLOW_BACKUP_FAILURE=1
  HEALTH_URL=http://127.0.0.1:18080/healthz
  NO_CACHE=1
EOF
}

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

SCRIPT_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(basename "$SCRIPT_SOURCE_DIR")" = "source" ]; then
  DEFAULT_APP_ROOT=$(dirname "$SCRIPT_SOURCE_DIR")
  DEFAULT_SOURCE_DIR="$SCRIPT_SOURCE_DIR"
else
  DEFAULT_APP_ROOT="/volume1/docker/ai-conversation-archive"
  DEFAULT_SOURCE_DIR="$DEFAULT_APP_ROOT/source"
fi

APP_ROOT=${APP_ROOT:-"$DEFAULT_APP_ROOT"}
SOURCE_DIR=${SOURCE_DIR:-"$DEFAULT_SOURCE_DIR"}
PACKAGE=${1:-${PACKAGE:-}}
BACKUP_ROOT=${BACKUP_ROOT:-"/volume1/backup/ai-conversation-archive"}
SKIP_BACKUP=${SKIP_BACKUP:-0}
ALLOW_BACKUP_FAILURE=${ALLOW_BACKUP_FAILURE:-0}
HEALTH_RETRIES=${HEALTH_RETRIES:-60}
HEALTH_SLEEP=${HEALTH_SLEEP:-2}
NO_CACHE=${NO_CACHE:-1}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

env_value() {
  key=$1
  file=$2
  [ -f "$file" ] || return 1
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | sed 's/^"//; s/"$//'
}

docker_cli() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    sudo -n docker "$@"
    return
  fi
  return 127
}

compose_with() {
  env_file=$1
  compose_file=$2
  shift 2
  if docker_cli compose version >/dev/null 2>&1; then
    docker_cli compose --env-file "$env_file" -f "$compose_file" "$@"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose --env-file "$env_file" -f "$compose_file" "$@"
    return
  fi
  die "Docker Compose is not available."
}

http_ok() {
  url=$1
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url" >/dev/null 2>&1
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" >/dev/null 2>&1
    return $?
  fi
  return 2
}

http_get() {
  url=$1
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
    return
  fi
  return 2
}

package_version() {
  file=$1
  [ -f "$file" ] || return 1
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

expected_app_version() {
  source_dir=$1
  version_file="$source_dir/apps/server/src/version.ts"
  if [ -f "$version_file" ]; then
    version=$(sed -n 's/^export const APP_VERSION = "\([^"]*\)".*/\1/p' "$version_file" | head -n 1)
    if [ -n "$version" ]; then
      printf '%s\n' "$version"
      return
    fi
  fi
  package_version "$source_dir/package.json" || true
}

build_app_image() {
  env_file=$1
  compose_file=$2
  if [ "$NO_CACHE" = "1" ]; then
    log "Building server image with --no-cache..."
    compose_with "$env_file" "$compose_file" build --no-cache app
  else
    log "Building server image..."
    compose_with "$env_file" "$compose_file" build app
  fi
}

ensure_data_dirs() {
  env_file=$1
  fallback_root=$2
  data_dir=$(env_value ARCHIVE_DATA_DIR "$env_file" || true)
  [ -n "$data_dir" ] || data_dir="$fallback_root/data"
  if mkdir -p \
      "$data_dir/postgres" \
      "$data_dir/imports/inbox" \
      "$data_dir/imports/processed" \
      "$data_dir/imports/failed" 2>/dev/null \
    && chown -R 1000:1000 "$data_dir/imports" 2>/dev/null \
    && chmod -R u+rwX,go-rwx "$data_dir/imports" 2>/dev/null; then
    log "Ensured data directories under $data_dir"
    return
  fi

  helper_image=${DATA_DIR_HELPER_IMAGE:-ai-conversation-archive:latest}
  log "Direct data-directory maintenance is unavailable; using Docker image $helper_image."
  if docker_cli image inspect "$helper_image" >/dev/null 2>&1 \
    && docker_cli run --rm --user 0:0 --entrypoint sh \
      -v "$data_dir:/archive-data" "$helper_image" -c \
      'mkdir -p /archive-data/postgres /archive-data/imports/inbox /archive-data/imports/processed /archive-data/imports/failed && chown -R 1000:1000 /archive-data/imports && chmod -R u+rwX,go-rwx /archive-data/imports'; then
    log "Ensured data directories under $data_dir with Docker."
    return
  fi
  die "Cannot grant the non-root app user access to $data_dir/imports. Grant filesystem ownership or set DATA_DIR_HELPER_IMAGE to a locally available image."
}

run_backup() {
  source_dir=$1
  env_file=$2
  compose_file=$3
  if [ "$SKIP_BACKUP" = "1" ]; then
    log "Skipping database backup because SKIP_BACKUP=1."
    return
  fi
  if [ ! -f "$source_dir/scripts/backup.sh" ]; then
    if [ "$ALLOW_BACKUP_FAILURE" = "1" ]; then
      log "Backup script not found; continuing because ALLOW_BACKUP_FAILURE=1."
      return
    fi
    die "Backup script not found: $source_dir/scripts/backup.sh"
  fi
  postgres_user=$(env_value POSTGRES_USER "$env_file" || true)
  postgres_db=$(env_value POSTGRES_DB "$env_file" || true)
  [ -n "$postgres_user" ] || postgres_user=archive
  [ -n "$postgres_db" ] || postgres_db=archive
  log "Creating database backup before update..."
  if POSTGRES_USER="$postgres_user" POSTGRES_DB="$postgres_db" \
    BACKUP_ROOT="$BACKUP_ROOT" ENV_FILE="$env_file" COMPOSE_FILE="$compose_file" \
    sh "$source_dir/scripts/backup.sh"; then
    log "Backup completed."
    return
  fi
  if [ "$ALLOW_BACKUP_FAILURE" = "1" ]; then
    log "Backup failed; continuing because ALLOW_BACKUP_FAILURE=1."
    return
  fi
  die "Backup failed. Set SKIP_BACKUP=1 only when you intentionally do not need a backup."
}

wait_health() {
  env_file=$1
  expected_version=${2:-}
  archive_port=$(env_value ARCHIVE_PORT "$env_file" || true)
  [ -n "$archive_port" ] || archive_port=18080
  health_url=${HEALTH_URL:-"http://127.0.0.1:${archive_port}/healthz"}
  if [ -n "$expected_version" ]; then
    log "Waiting for application health: $health_url (expected version $expected_version)"
  else
    log "Waiting for application health: $health_url"
  fi
  i=1
  while [ "$i" -le "$HEALTH_RETRIES" ]; do
    if body=$(http_get "$health_url" 2>/dev/null); then
      if [ -z "$expected_version" ]; then
        log "Server update completed successfully."
        return
      fi
      if printf '%s' "$body" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"$expected_version\""; then
        log "Server update completed successfully. Running version: $expected_version"
        return
      fi
      seen_version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
      [ -n "$seen_version" ] || seen_version=unknown
      log "Health endpoint is up but running version is $seen_version; waiting for $expected_version..."
    fi
    sleep "$HEALTH_SLEEP"
    i=$((i + 1))
  done
  return 1
}

command -v docker >/dev/null 2>&1 || die "Docker is not available."

APP_ROOT=$(CDPATH= cd -- "$APP_ROOT" 2>/dev/null && pwd || printf '%s' "$APP_ROOT")
SOURCE_DIR=$(CDPATH= cd -- "$SOURCE_DIR" 2>/dev/null && pwd || printf '%s' "$SOURCE_DIR")
STAMP=$(date +%Y%m%d-%H%M%S)

if [ -n "$PACKAGE" ]; then
  [ -f "$PACKAGE" ] || die "Package not found: $PACKAGE"
  [ -d "$SOURCE_DIR" ] || die "Existing source directory not found: $SOURCE_DIR"
  OLD_ENV_FILE="$SOURCE_DIR/deploy/.env"
  OLD_COMPOSE_FILE="$SOURCE_DIR/deploy/docker-compose.yml"
  [ -f "$OLD_ENV_FILE" ] || die "Existing env file not found: $OLD_ENV_FILE"
  [ -f "$OLD_COMPOSE_FILE" ] || die "Existing compose file not found: $OLD_COMPOSE_FILE"

  run_backup "$SOURCE_DIR" "$OLD_ENV_FILE" "$OLD_COMPOSE_FILE"

  STAGING_DIR="$APP_ROOT/source-next-$STAMP"
  PREVIOUS_DIR="$APP_ROOT/source-prev-$STAMP"
  mkdir -p "$STAGING_DIR"
  log "Extracting package to $STAGING_DIR"
  tar -xzf "$PACKAGE" -C "$STAGING_DIR"
  cp "$OLD_ENV_FILE" "$STAGING_DIR/deploy/.env"

  NEW_ENV_FILE="$STAGING_DIR/deploy/.env"
  NEW_COMPOSE_FILE="$STAGING_DIR/deploy/docker-compose.yml"
  ensure_data_dirs "$NEW_ENV_FILE" "$APP_ROOT"

  build_app_image "$NEW_ENV_FILE" "$NEW_COMPOSE_FILE"

  log "Switching source directory."
  mv "$SOURCE_DIR" "$PREVIOUS_DIR"
  mv "$STAGING_DIR" "$SOURCE_DIR"
  ENV_FILE="$SOURCE_DIR/deploy/.env"
  COMPOSE_FILE="$SOURCE_DIR/deploy/docker-compose.yml"
  EXPECTED_VERSION=$(expected_app_version "$SOURCE_DIR")
else
  ENV_FILE="$SOURCE_DIR/deploy/.env"
  COMPOSE_FILE="$SOURCE_DIR/deploy/docker-compose.yml"
  [ -f "$ENV_FILE" ] || die "Env file not found: $ENV_FILE"
  [ -f "$COMPOSE_FILE" ] || die "Compose file not found: $COMPOSE_FILE"

  run_backup "$SOURCE_DIR" "$ENV_FILE" "$COMPOSE_FILE"
  ensure_data_dirs "$ENV_FILE" "$APP_ROOT"
  build_app_image "$ENV_FILE" "$COMPOSE_FILE"
  EXPECTED_VERSION=$(expected_app_version "$SOURCE_DIR")
fi

log "Starting services with forced host-monitor/app/worker recreation..."
compose_with "$ENV_FILE" "$COMPOSE_FILE" up -d postgres
compose_with "$ENV_FILE" "$COMPOSE_FILE" up -d --force-recreate host-monitor app worker

if wait_health "$ENV_FILE" "$EXPECTED_VERSION"; then
  compose_with "$ENV_FILE" "$COMPOSE_FILE" ps
  exit 0
fi

log "Application did not become healthy in time. Recent logs:"
compose_with "$ENV_FILE" "$COMPOSE_FILE" logs --tail=120 host-monitor app worker
exit 1
