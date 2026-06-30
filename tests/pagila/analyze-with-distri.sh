#!/usr/bin/env bash
# End-to-end: download a public dataset (Pagila), then use distri to ANALYZE it
# and AUTHOR cubes + reports — distri cloud runs the agent loop, the Bash/Write
# tools run LOCALLY here (no --remote), so the agent reaches the local DB and
# writes files to this repo.
#
# Requires DISTRI_API_KEY / DISTRI_WORKSPACE_ID in tests/pagila/.env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

[ -f "$HERE/.env" ] || { echo "create tests/pagila/.env from .env.sample (with DISTRI_* keys) first"; exit 1; }
set -a; source "$HERE/.env"; set +a
: "${DISTRI_API_KEY:?set DISTRI_API_KEY in tests/pagila/.env}"
: "${DISTRI_WORKSPACE_ID:?set DISTRI_WORKSPACE_ID in tests/pagila/.env}"

echo "==> 1/5 setup dataset"; "$HERE/setup.sh"
echo "==> 2/5 build server"; cargo build -q -p spyglass --bin spyglass-server

echo "==> 3/5 distri: generate cubes from the live DB (local tools)"
distri agents push "$HERE/distri/spyglass_cubegen.md"
distri run --agent spyglass_cubegen --task \
  "Generate Spyglass cubes for the Pagila tables: payment, rental, customer, film.
   Profile them with ./target/debug/spyglass-server analyze --profile and write the
   cube YAML to ./tests/pagila/cubes/pagila-distri.yml following ./skills/schema-to-cubes.md.
   payment/rental/customer share a store via store_id (join where needed) — mark store_id
   tenant:true; film is a shared catalog with no tenant."
./target/debug/spyglass-server -C tests/pagila validate || true

echo "==> 4/5 serve (background)"
pkill -f "spyglass-server -C tests/pagila" 2>/dev/null || true
( ./target/debug/spyglass-server -C tests/pagila serve >"$HERE/logs/serve.log" 2>&1 & )
sleep 3

echo "==> 5/5 distri: build reports against the running server (local tools)"
distri agents push "$HERE/distri/spyglass_reporter.md"
distri run --agent spyglass_reporter --task \
  "Build 2 sample reports against the running spyglass-server at localhost:${REPORTING_ADDR##*:}.
   curl /meta to discover cubes, scope to store_id 1, save each to tests/pagila/reports/<id>.json
   AND POST to /reports, then verify /reports/<id>/run has no failed widgets."

echo "==> done. Reports:"; curl -s "localhost:${REPORTING_ADDR##*:}/reports"
echo; echo "Open http://${REPORTING_ADDR} for the explorer UI."
