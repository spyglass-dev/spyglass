---
id: analyze
title: Analyzing your data
sidebar_position: 5
---

# Analyzing your data (`analyze`)

`analyze` **profiles a database** — row counts, column cardinality, value
ranges, and the most common values — so you (or a [distri](./generating-cubes.md)
agent) can author good cubes. It's the step that turns a bare schema into *useful*
cubes: the profile tells you which columns are real categorical **dimensions**,
which are numeric **measures**, which are ids, and what date range the data spans.

:::info Offline / admin path
`analyze` is **not** the tenant-scoped runtime path. It issues many read-only
queries against `DATABASE_URL` and is meant for an offline/admin setup (or an
agent building cubes). Keep it off your request hot-path.
:::

## Two ways to call it

### CLI (offline)

The `spyglass-server` binary connects to `DATABASE_URL` and prints JSON:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/mydb

# Profile every table.
spyglass-server analyze --profile

# Profile specific tables (repeatable).
spyglass-server analyze --profile --table orders --table customers

# Scope the profile to one tenant's rows (so stats reflect real per-tenant data).
spyglass-server analyze --profile --filter workspace_id=ws_123

# Tune sampling.
spyglass-server analyze --profile --top 20        # top-N values per categorical column
```

Use `-C <dir>` to resolve `.env`/paths inside a working directory, e.g.
`spyglass-server -C tests/pagila analyze --profile --table payment`.

### HTTP (`POST /analyze`)

The running server also exposes analyze, for a UI/admin tool. The body is the
same option set:

```bash
curl -s localhost:8088/analyze -H 'content-type: application/json' -d '{
  "profile_values": true,
  "tables": ["orders", "customers"],
  "top_k": 20
}'
```

## Flags / options

| CLI flag | JSON field | Meaning |
|----------|-----------|---------|
| `--profile` | `profile_values: true` | Profile column values (cardinality, top values, ranges). Without it you get just schema + row counts. |
| `--table NAME` (repeatable) | `tables: ["…"]` | Limit to these tables (default: all public tables). |
| `--filter col=val` | `filter: { column, value }` | Restrict profiling to rows matching `col = val` (e.g. one tenant). |
| `--top N` | `top_k: N` | How many top values to sample per categorical column (default 10). |
| — | `large_table_rows: N` | Skip expensive `count(distinct …)` on tables larger than this. |

## Output shape

```jsonc
{
  "tables": [
    {
      "name": "orders",
      "row_count": 1280,
      "columns": [
        {
          "name": "status",
          "data_type": "text",
          "nullable": false,
          "distinct_count": 3,
          "null_count": 0,
          "top_values": [
            { "value": "paid", "count": 900 },
            { "value": "open", "count": 320 },
            { "value": "void", "count": 60 }
          ],
          "suggested_role": "dimension"
        },
        {
          "name": "amount_cents",
          "data_type": "integer",
          "min": "199", "max": "48000",
          "suggested_role": "measure"
        }
      ]
    }
  ]
}
```

## Reading the profile → cubes

The profile is what makes cubes good:

- **`suggested_role`** (`dimension` \| `measure` \| `id` \| `skip`) is a hint per
  column. `distinct_count` + `top_values` reveal real categorical **dimensions**
  (the actual `status` values to expect); numeric columns + `min`/`max` reveal
  **measures**; `*_id` columns are keys; `min`/`max` on timestamps show the
  usable date range.
- Mark the tenant column (`workspace_id`, or a `store_id`-style key) `tenant: true`
  — see [The cube format](./cube-format.md).
- For "count of rows meeting a condition", the real values from `top_values` tell
  you the exact `case when status = 'paid' then 1 else 0 end` to write.

For the richer **`bundle`** variant (schema + profile + your source code in one
JSON, for an agent), and the full agent-driven flow, see
[Generating cubes with distri](./generating-cubes.md). Validate the cubes you
write offline with `spyglass-server validate` (loads them, no DB).

## Try it on a real dataset

The repo ships a one-command harness that loads the public
[Pagila](https://github.com/devrimgunduz/pagila) dataset into Docker and runs the
whole analyze → cubes → reports flow — see `tests/pagila/`.
