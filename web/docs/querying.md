---
id: querying
title: Querying
sidebar_position: 6
---

# Querying

The runtime path is a single endpoint: `POST /query`. You ask for measures and
dimensions; Spyglass compiles parameterized SQL, injects the tenant scope, runs
it, and returns rows.

## The query shape

Queries are Cube-shaped JSON:

```json
{
  "measures": ["Orders.count", "Orders.revenue"],
  "dimensions": ["Orders.status"],
  "filters": [
    { "member": "Orders.status", "operator": "equals", "values": ["paid"] }
  ],
  "timeDimensions": [
    {
      "dimension": "Orders.created_at",
      "granularity": "week",
      "dateRange": ["2026-01-01", "2026-02-01"]
    }
  ],
  "limit": 100
}
```

- **measures** / **dimensions** — `Cube.member` names from your model. Never
  invent names; use what the model declares.
- **filters** — `{ member, operator, values }`.
- **timeDimensions** — bucket a `type: time` dimension by `granularity` over a
  `dateRange`.
- **limit** — row cap.

## The endpoint

The request body wraps the query with a `scope`:

```bash
curl -s localhost:8088/query \
  -H 'content-type: application/json' \
  -d '{
        "query": {
          "measures": ["Orders.revenue"],
          "dimensions": ["Orders.status"]
        },
        "scope": { "Orders.tenant_id": "ws_123" }
      }'
```

`GET /health` returns `{ "ok": true }`.

## Scope

The `scope` object pins the **security context**. Every dimension marked
`tenant: true` in the model is filled from `scope` and injected as a mandatory
`WHERE` filter. Callers **cannot** widen the scope or omit it — that is the core
guarantee. In an embedded deployment the host builds the `SecurityContext`
server-side from the authenticated session, so the tenant value never comes from
the caller.

## Server endpoints

`spyglass-server serve` exposes a small HTTP surface:

| Method & path | Purpose |
|---------------|---------|
| `GET /` | The UI — the embedded [Studio](./widgets.md#studio) app (`--features ui`), or a zero-build explorer otherwise (cubes + query runner + reports). |
| `GET /health` | `{ "ok": true }`. |
| `GET /meta` | The **catalog** — cubes with their measures/dimensions (`Cube.member` names, types, tenant flags) and no SQL. What a UI uses to build queries. |
| `POST /query` | Run a query (above). |
| `POST /analyze` | Profile the data — see [Analyzing your data](./analyze.md). |
| `GET /schema` | Raw DB schema (admin/introspection). |
| `GET /reports` · `POST /reports` | List / save bound reports. |
| `GET /reports/{id}` | A saved report template. |
| `POST /reports/{id}/run` | Run a report's bound queries under a scope → a data-bearing [`ReportDoc`](./widgets.md). |

A UI builds queries from `GET /meta` — cubes with their members, types, and the
tenant flag, and no SQL:

```jsonc
{
  "cubes": [
    {
      "name": "Orders",
      "title": "Orders",
      "measures": [
        { "name": "revenue", "member": "Orders.revenue", "type": "sum", "format": "currency" }
      ],
      "dimensions": [
        { "name": "tenant_id", "member": "Orders.tenant_id", "type": "string", "tenant": true },
        { "name": "status",    "member": "Orders.status",    "type": "string", "tenant": false }
      ]
    }
  ]
}
```

`spyglass-server validate` (no server, no DB) loads the cube directory and
reports cubes/measures/dimensions — for CI or an agent self-checking generated
cubes.

## Relative date ranges

`timeDimensions[].dateRange` accepts an absolute `[from, to)` pair **or** a
relative expression, resolved server-side each time the query runs — so a
saved document stores the *intent* and the window moves:

```json
{ "measures": ["Orders.count"],
  "timeDimensions": [{ "dimension": "Orders.created_at", "dateRange": "last 30 days" }],
  "timezone": "Europe/London" }
```

Grammar: `today` · `yesterday` · `ytd` · `last N days|weeks|months|quarters|years`
(the current period plus the N−1 before it, so `last 30 days` includes today)
· `next N <unit>` (the mirror — the current period plus the N−1 after it, so
`next 31 days` starts today; forward windows like "trials ending soon")
· `this week|month|quarter|year` · `previous <unit>` (`last <unit>` with no
number means the same). Periods are calendar-aligned in the query's
`timezone` (IANA name, default UTC); weeks start on Monday (ISO). An
unrecognized expression is a typed compile error listing the accepted forms.

Resolution is clock-injected: the compiler never reads system time
(`compile_at(model, query, ctx, now)`; the engine passes the real clock, and
the clockless `compile()` refuses relative ranges outright), so the same
document at the same instant always compiles to the same SQL.

## Comparison windows and gap filling

Two features on the time dimension, sharing one contract — a `dateRange` to
anchor on, and the time dimension as the query's **only** grouping:

```json
{ "measures": ["Orders.count"],
  "timeDimensions": [{ "dimension": "Orders.created_at", "granularity": "day",
                       "dateRange": "last 30 days",
                       "compare": "previous_period", "fillGaps": true }] }
```

- **`compare`** (`previous_period` | `previous_year`) runs the same query
  over the shifted window and folds its measures in as `__prev_<measure>`
  columns (kind `prev_measure`) — real deltas for metrics, a ghost series
  for charts. `previous_period` shifts back by the window's own width;
  `previous_year` by one calendar year. Series rows align by time-sorted
  position, so set `fillGaps` on sparse series; a bucket with no
  counterpart merges as `null` — "no data then" is not "zero then". A
  granularity-less time dimension is **filter-only** (Cube semantics), which
  is what lets a metric query carry a window and a comparison.
- **`fillGaps`** wraps the aggregate in a `generate_series` join over the
  window's buckets, so an empty bucket appears as `0` instead of vanishing
  (requires a `granularity`). With `includeTotal`, the total counts buckets.

## Pagination and totals

`limit`, `offset`, and `includeTotal` page a query server-side:

```json
{ "measures": ["Orders.count"], "dimensions": ["Orders.status"],
  "limit": 25, "offset": 50, "includeTotal": true }
```

`includeTotal` adds one `count(*) over ()` window column to the same
statement — one query, not two; on a grouped query it counts **groups**,
which is what "1–25 of 312" means. The engine strips it into
`QueryResult.total` and derives `has_more`. When the engine has a row cap
(`with_max_rows` / `SPYGLASS_MAX_ROWS`), a clamped result that fills the cap
is reported via `truncated_at` — a truncated table must never look complete.

## Measure filters (HAVING)

A filter whose member is a **measure** compiles into `HAVING` against the
aggregate expression — "customers with revenue ≥ 1000" is
`{ "member": "Orders.revenue", "operator": "gte", "values": [1000] }`. This
is what makes "top/worst/only-if" questions buildable. Dimension filters
stay in `WHERE`; the split is by member kind, not by position.

## Row mode

`"mode": "rows"` returns row-level records instead of aggregates: no
grouping, and the projection is the requested dimensions ∩ the cube's
[`drill_members`](./cube-format.md#row-mode-boundary-drill_members) (all of
them when none are requested). A cube without `drill_members` refuses row
mode — it has not published a record shape. Filters, tenant scope, order
and pagination all apply unchanged; measures and measure filters are
compile errors.

## Joins in queries

A query's measures pick its **base cube**; dimensions and filters may
reference other cubes reachable over the model's [`joins:`](./cube-format.md#joins)
edges, and the compiler emits `LEFT JOIN`s automatically. A labelled dimension
adds its `"{member}__label"` column to the result without being asked.

Two refusals are guarantees, not gaps:

- `FanOut` — the query would traverse a `one_to_many` edge, duplicating base
  rows and inflating aggregates. Declare the query on the many side.
- `MissingTenantScope` — *any* cube in the join tree declares a tenant
  dimension the `SecurityContext` has no scope for. Joins never widen tenant
  access.

## Batch queries, `/values`, and the result cache

- **Batch**: `POST /query { "queries": [Query, …], "scope": … }` runs every
  query in one request over one connection — a 12-widget report is one round
  trip instead of 12. The response is `{ "results": [...] }` with one entry
  per query: a `QueryResult`, or `{ "error": … }` for that query alone — one
  bad widget must not blank the other eleven. The single-query form
  (`{ "query": … }`) is unchanged.
- **`POST /values { member, search?, limit?, scope }`** returns
  `{ "values": [{ value, label?, count }] }` — scope-filtered, label-resolved
  distinct values of a dimension marked
  [`filterable: true`](./cube-format.md#curation). The flag is the allowlist:
  `/values` never serves a dimension the model didn't explicitly offer for
  filtering. Search matches what the user *sees* (the label when the
  dimension has one); results order by count descending; limit defaults to
  50, capped at 500. Tenant scope is enforced exactly as for `/query`,
  label-join cubes included.
- **Result cache**: `SPYGLASS_CACHE_TTL_MS` (or `with_cache(ttl)` when
  embedding) enables a short-TTL in-process cache. The key includes the
  compiled SQL, bound params, any comparison window, **and the tenant
  scope** — a cache that can return one tenant's rows to another is worse
  than no cache. Relative date windows roll over naturally because the
  resolved instants live in the params.

## Compiler guarantees

- **Injection-safe** — values are bound parameters; only declared members reach
  SQL.
- **Scoped by construction** — no query can escape the tenant filter or touch
  raw tables; tenant scope applies to **every cube in a join tree**, and its
  absence is a compile error.
- **No silent fan-out** — a join that would multiply rows is a compile error
  (`FanOut`), never a quietly wrong number.
- **Pure** — the compiler (`Query` + `Model` + `SecurityContext` → SQL) needs no
  database, which is why the test suite runs offline.

## Embedding

Skip HTTP entirely and call the engine in-process:

```rust
let ctx = SecurityContext { scope };       // host-built, server-side
let result = engine.run(&model, &query, &ctx).await?;
```
