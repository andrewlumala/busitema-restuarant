#!/usr/bin/env bash
# Backs up the database to a timestamped .sql file. Works against either a local
# Docker setup (uses DB_* vars) or a cloud database (uses DATABASE_URL).
#
# Usage: ./scripts/backup-db.sh
# Requires pg_dump installed locally, or run it inside the Docker container:
#   docker compose exec api ./scripts/backup-db.sh

set -e

TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
OUT_DIR="./backups"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/backup_$TIMESTAMP.sql"

if [ -n "$DATABASE_URL" ]; then
  echo "Backing up via DATABASE_URL..."
  pg_dump "$DATABASE_URL" > "$OUT_FILE"
else
  echo "Backing up via local DB_* variables..."
  PGPASSWORD="${DB_PASSWORD:-postgres}" pg_dump \
    -h "${DB_HOST:-localhost}" \
    -p "${DB_PORT:-5432}" \
    -U "${DB_USER:-postgres}" \
    "${DB_NAME:-busitema_canteen}" > "$OUT_FILE"
fi

echo "✅ Backup written to $OUT_FILE"
echo ""
echo "Restore with:"
echo "  psql \$DATABASE_URL < $OUT_FILE     (cloud)"
echo "  psql -U postgres -d busitema_canteen < $OUT_FILE     (local)"
echo ""
echo "Note: Neon's paid tiers include automatic point-in-time recovery, which is more"
echo "reliable than manual backups for a real pilot — worth checking once you're past testing."
