#!/usr/bin/env bash
# Serve the Pagila cubes against the Docker dataset (port 8089).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

[ -f "$HERE/.env" ] && { set -a; source "$HERE/.env"; set +a; } || { set -a; source "$HERE/.env.sample"; set +a; }

echo "Building spyglass-server…"
cargo build -q -p spyglass --bin spyglass-server
echo "Serving tests/pagila/cubes against $DATABASE_URL"
exec ./target/debug/spyglass-server -C tests/pagila serve
