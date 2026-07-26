#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$ROOT_DIR/deploy/docker-compose.yml"}
ENV_FILE=${ENV_FILE:-"$ROOT_DIR/deploy/.env"}
BACKUP_ROOT=${BACKUP_ROOT:-"/volume1/backup/ai-conversation-archive"}
STAMP=$(date +%Y-%m-%d_%H%M%S)
DAY=$(date +%u)
MONTH_DAY=$(date +%d)

mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/monthly"

[ -f "$ENV_FILE" ] || { echo "Compose environment not found: $ENV_FILE" >&2; exit 1; }

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-archive}" -d "${POSTGRES_DB:-archive}" \
  --format=custom --no-owner --no-privileges > "$BACKUP_ROOT/daily/archive_$STAMP.dump"

LATEST="$BACKUP_ROOT/daily/archive_$STAMP.dump"
[ "$DAY" = "7" ] && cp "$LATEST" "$BACKUP_ROOT/weekly/archive_$STAMP.dump"
[ "$MONTH_DAY" = "01" ] && cp "$LATEST" "$BACKUP_ROOT/monthly/archive_$STAMP.dump"

prune_count() {
  find "$1" -type f -name '*.dump' | sort -r | awk -v keep="$2" 'NR > keep' |
    while IFS= read -r old_backup; do rm -f "$old_backup"; done
}

prune_count "$BACKUP_ROOT/daily" 7
prune_count "$BACKUP_ROOT/weekly" 4
prune_count "$BACKUP_ROOT/monthly" 12
echo "Backup complete: $LATEST"
