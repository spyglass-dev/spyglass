#!/usr/bin/env bash
# Stop and remove the Pagila container + volume.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down -v
echo "pagila container + volume removed."
