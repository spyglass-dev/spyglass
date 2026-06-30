---
name: schema_to_cubes
description: "Turn a raw database schema into reporting cube definitions. Pull the schema (GET /schema on the reporting server, or the host's schema dump), then map tables → cubes with measures (aggregations) and dimensions (group-by/filter columns), ready to drop into the engine's cubes directory."
tags:
  - reporting
  - schema
  - cubes
---

# Schema → Cubes

You turn a raw Postgres schema into **cube definitions** the reporting engine
can serve. One pass: pull the schema, then emit cubes.

This runs **offline / in an admin setup** — building cubes is not a runtime
path. Drive the `spyglass-server` binary (it connects to `DATABASE_URL`):

- `spyglass-server schema` → `{ tables: [{ name, columns: [{ name, data_type,
  nullable }] }] }` (structure, from `information_schema`).
- `spyglass-server analyze --profile [--table NAME] [--filter col=val]` →
  a data PROFILE per table: `row_count`, and per column `null_count`,
  `distinct_count`, `min`/`max`, `top_values`, and a `suggested_role`
  (`dimension` | `measure` | `id` | `skip`). Run it repeatedly across tables —
  it's safe to issue many read-only queries here.
- `spyglass-server bundle --profile --source <path>…` → ONE JSON with the
  schema, the data profile, AND the contents of the given code/files
  (e.g. the host's `schema.rs` + services). Use this when running under the
  distri CLI: read the code and the data together, then write cube files. The
  service/query code often reveals intent (which columns are statuses, scores,
  tenant keys) that the schema alone doesn't.

## Recipe

1. **Pull schema + profile.** Run `schema`, then `analyze --profile` on the
   candidate tables. The profile is what makes the cubes good: distinct/top
   values reveal categorical **dimensions** (e.g. the real `status` values),
   numeric columns + ranges reveal **measures**, `*_id` columns are keys, and
   `min`/`max` on timestamps show the usable date range.

2. **Pick the entities worth reporting on.** Favor the tables that answer real
   questions for this domain; skip pure join tables and internal bookkeeping
   unless a metric needs them.

3. **Map each table to a cube:**
   - `sql_table: <table>` (or an inline `sql:` join when a metric needs columns
     from another table — e.g. a fact table joined to a dimension table).
   - **Dimensions** = columns you group/filter by: ids, status, names, and
     `*_at` timestamps (`type: time`). Mark the tenant column
     (`workspace_id`) `tenant: true`.
   - **Measures** = aggregations. `count` for row counts; `count_distinct` for
     unique ids; `sum`/`avg`/`min`/`max` over numeric columns. For "count of
     rows meeting a condition", use `sum` with
     `sql: "case when <cond> then 1 else 0 end"` (a plain `count` ignores its
     `sql`). Cast/format hints: `format: percent` for ratios.

4. **Honor the tenant rule.** Every cube that holds tenant data MUST expose a
   `workspace_id` dimension marked `tenant: true` — the host injects it as a
   mandatory scope filter, so a cube without it can't be safely queried.

5. **Emit YAML** under `cubes:` (one file or many; the loader merges a
   directory). Validate by loading + running a trivial query per cube.

## Output shape

```yaml
cubes:
  Orders:
    sql: >
      select o.*, c.region from orders o
      join customers c on c.id = o.customer_id
    dimensions:
      tenant_id:  { type: string, sql: tenant_id, tenant: true }
      region:     { type: string, sql: region }
      created_at: { type: time,   sql: created_at }
    measures:
      count:   { type: count }
      paid:    { type: sum, sql: "case when status = 'paid' then 1 else 0 end" }
      revenue: { type: sum, sql: amount_cents }
```

## Rules

- Never invent columns — use only what the schema reports.
- Conditional counts go through `sum(case when … then 1 else 0 end)`.
- Tenant dimension is mandatory on tenant cubes.
- Keep measure/dimension names stable and human (`revenue`, `avg_order`) —
  the agent and UI reference them by `Cube.member`.
