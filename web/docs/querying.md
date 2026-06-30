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
        "scope": { "tenant_id": "ws_123" }
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
| `GET /` | The embedded explorer UI (cubes + query runner + reports). |
| `GET /health` | `{ "ok": true }`. |
| `GET /meta` | The **catalog** — cubes with their measures/dimensions (`Cube.member` names, types, tenant flags) and no SQL. What a UI uses to build queries. |
| `POST /query` | Run a query (above). |
| `POST /analyze` | Profile the data — see [Analyzing your data](./analyze.md). |
| `GET /schema` | Raw DB schema (admin/introspection). |
| `GET /reports` · `POST /reports` | List / save bound reports. |
| `GET /reports/{id}` | A saved report template. |
| `POST /reports/{id}/run` | Run a report's bound queries under a scope → a data-bearing [`ReportDoc`](./widgets.md). |

`spyglass-server validate` (no server, no DB) loads the cube directory and
reports cubes/measures/dimensions — for CI or an agent self-checking generated
cubes.

## Compiler guarantees

- **Injection-safe** — values are bound parameters; only declared members reach
  SQL.
- **Scoped by construction** — no query can escape the tenant filter or touch
  raw tables.
- **Pure** — the compiler (`Query` + `Model` + `SecurityContext` → SQL) needs no
  database, which is why the test suite runs offline.

## Embedding

Skip HTTP entirely and call the engine in-process:

```rust
let ctx = SecurityContext { scope };       // host-built, server-side
let result = engine.run(&model, &query, &ctx).await?;
```
