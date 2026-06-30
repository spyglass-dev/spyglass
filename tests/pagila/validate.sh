#!/usr/bin/env bash
# Validate the Pagila cubes against a running server: load check, a query per
# cube, and a scope-isolation assertion (store 1 vs store 2 differ).
#   ./setup.sh && ./serve.sh   (in another shell)   then   ./validate.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && { set -a; source "$HERE/.env"; set +a; } || { set -a; source "$HERE/.env.sample"; set +a; }
ADDR="${REPORTING_ADDR:-127.0.0.1:8089}"
fails=0

q() { curl -s "http://$ADDR/query" -H 'content-type: application/json' -d "$1"; }
num() { grep -o "\"$1\":[0-9.]*" | head -1 | grep -o '[0-9.]*$'; }

echo "== health =="
curl -sf "http://$ADDR/health" >/dev/null && echo "  ok" || { echo "  server not up on $ADDR"; exit 1; }

echo "== per-cube smoke test (store 1) =="
for cube in Payment Rental Customer; do
  r=$(q "{\"query\":{\"measures\":[\"$cube.count\"]},\"scope\":{\"$cube.store_id\":1}}")
  if echo "$r" | grep -q '"error"'; then echo "  FAIL $cube -> $r"; fails=$((fails+1));
  else echo "  ok   $cube.count = $(echo "$r" | num "$cube.count")"; fi
done
# Film has no tenant — query without scope.
r=$(q '{"query":{"measures":["Film.count","Film.avg_rental_rate"]}}')
echo "$r" | grep -q '"error"' && { echo "  FAIL Film -> $r"; fails=$((fails+1)); } || echo "  ok   Film.count = $(echo "$r" | num Film.count)"

echo "== revenue by store (scope isolation) =="
r1=$(q '{"query":{"measures":["Payment.revenue"]},"scope":{"Payment.store_id":1}}' | num Payment.revenue)
r2=$(q '{"query":{"measures":["Payment.revenue"]},"scope":{"Payment.store_id":2}}' | num Payment.revenue)
echo "  store 1 revenue=$r1  store 2 revenue=$r2"
if [ -n "$r1" ] && [ -n "$r2" ] && [ "$r1" != "$r2" ]; then echo "  ok (scope filter applied)"; else echo "  FAIL (scope not isolating)"; fails=$((fails+1)); fi

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$fails CHECK(S) FAILED"; exit 1; }
