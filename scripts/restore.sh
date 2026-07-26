#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/archive.dump" >&2
  exit 2
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$ROOT_DIR/deploy/docker-compose.yml"}
ENV_FILE=${ENV_FILE:-"$ROOT_DIR/deploy/.env"}
BACKUP_FILE=$1

[ -f "$BACKUP_FILE" ] || { echo "Backup not found: $BACKUP_FILE" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Compose environment not found: $ENV_FILE" >&2; exit 1; }

echo "This replaces all data in ${POSTGRES_DB:-archive}. Type RESTORE to continue:"
read confirmation
[ "$confirmation" = "RESTORE" ] || exit 1

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop app worker
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  dropdb -U "${POSTGRES_USER:-archive}" --if-exists "${POSTGRES_DB:-archive}"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  createdb -U "${POSTGRES_USER:-archive}" "${POSTGRES_DB:-archive}"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "${POSTGRES_USER:-archive}" -d "${POSTGRES_DB:-archive}" \
  --no-owner --no-privileges < "$BACKUP_FILE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" start app worker
echo "Restore complete."
