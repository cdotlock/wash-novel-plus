#!/bin/sh
set -e

if [ "${RUN_DB_MIGRATIONS:-true}" = "true" ]; then
  if [ -d "./prisma/migrations" ] && [ "$(ls -A ./prisma/migrations)" ]; then
    echo "📦 Running Prisma migrations (migrate deploy)..."
    npx prisma migrate deploy
  else
    echo "📦 No migrations found. Syncing schema (prisma db push)..."
    npx prisma db push
  fi
fi

exec "$@"
