#!/usr/bin/env bash
# Bring up the Pagila Postgres container and load the dataset. Idempotent:
# re-running is a no-op once the data is present.
set -euo pipefail
cd "$(dirname "$0")"

BASE="https://raw.githubusercontent.com/devrimgunduz/pagila/master"
PSQL=(docker compose exec -T db psql -U postgres -d pagila -v ON_ERROR_STOP=1)

echo "==> starting postgres (port 5438)…"
docker compose up -d

echo "==> waiting for postgres to be ready…"
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U postgres -d pagila >/dev/null 2>&1; then break; fi
  sleep 1
done

# Already loaded?
loaded="$(docker compose exec -T db psql -U postgres -d pagila -tAc \
  "select coalesce((select count(*) from payment), 0)" 2>/dev/null | tr -d '[:space:]' || echo 0)"
if [ "${loaded:-0}" -gt 0 ]; then
  echo "==> pagila already loaded (${loaded} payments). Nothing to do."
  exit 0
fi

echo "==> downloading pagila SQL…"
mkdir -p .cache
for f in pagila-schema.sql pagila-data.sql; do
  if [ ! -s ".cache/$f" ]; then
    curl -fSL "$BASE/$f" -o ".cache/$f"
  fi
done

echo "==> loading schema…"
"${PSQL[@]}" -q < .cache/pagila-schema.sql
echo "==> loading data (this takes a few seconds)…"
"${PSQL[@]}" -q < .cache/pagila-data.sql

count="$(docker compose exec -T db psql -U postgres -d pagila -tAc 'select count(*) from payment' | tr -d '[:space:]')"
echo "==> done. ${count} payments loaded."
echo "    DATABASE_URL=postgres://postgres:postgres@localhost:5438/pagila"
