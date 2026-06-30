---
id: cube-format
title: The cube format
sidebar_position: 3
---

# The cube format

Spyglass models are written in a **Cube-style** YAML format. The term "cube"
comes from [**Cube**](https://cube.dev) (the open-source semantic layer —
repo: [cube-js/cube](https://github.com/cube-js/cube)). Spyglass adopts the same
core vocabulary — *cubes*, *measures*, *dimensions* — in a small, embeddable
form. It is **not** Cube and implements only the subset described here; treat
Cube's docs as background, this page as the source of truth for Spyglass.

## Shape

A model is one or more YAML files under a `cubes:` map. The loader merges every
file in a directory, so you can split cubes across files.

```yaml
cubes:
  Orders:
    sql_table: orders            # or `sql:` for an inline query / join
    title: Orders
    dimensions:
      tenant_id:
        type: string
        sql: tenant_id
        tenant: true             # mandatory scope, injected by the host
      status:
        type: string
        sql: status
      created_at:
        type: time
        sql: created_at
    measures:
      count:
        type: count
        title: Orders
      revenue:
        type: sum
        sql: amount_cents
        title: Revenue
      avg_order:
        type: avg
        sql: amount_cents
        title: Average order
```

## Cubes

A **cube** is a queryable entity. Source it from either:

- `sql_table: orders` — a plain table, or
- `sql: >` — an inline query, for when a metric needs columns from another table
  (e.g. a fact table joined to a dimension table):

  ```yaml
  Orders:
    sql: >
      select o.*, c.region from orders o
      join customers c on c.id = o.customer_id
  ```

## Dimensions

Dimensions are the columns you **group by** or **filter on**: ids, statuses,
names, and timestamps.

| Field | Meaning |
|-------|---------|
| `type` | `string`, `number`, `time`, `boolean` |
| `sql` | the column (or expression) |
| `tenant: true` | marks the mandatory scope column (see below) |

Use `type: time` for `*_at` timestamp columns — those become available for time
dimensions with granularities (`day`, `week`, `month`, …).

## Measures

Measures are **aggregations**.

| `type` | Produces |
|--------|----------|
| `count` | row count (ignores `sql`) |
| `count_distinct` | distinct count of `sql` |
| `sum` / `avg` / `min` / `max` | aggregation over the numeric `sql` |

For a **conditional count** ("rows meeting a condition"), use `sum` with a
`case` expression — a plain `count` ignores its `sql`:

```yaml
measures:
  paid: { type: sum, sql: "case when status = 'paid' then 1 else 0 end" }
```

Add `format: percent` on ratio measures so the UI renders them correctly.

## The tenant rule

Every cube that holds tenant data **must** expose a dimension marked
`tenant: true` (commonly `workspace_id` or `tenant_id`). The host pins the scope
via the [`SecurityContext`](./querying.md#scope) and Spyglass injects it as a
mandatory `WHERE` filter on every query. A cube without a tenant dimension can't
be safely queried in a multi-tenant deployment.

## Rules of thumb

- **Never invent columns** — use only what the schema actually has.
- Conditional counts go through `sum(case when … then 1 else 0 end)`.
- Keep measure/dimension names **stable and human** (`revenue`, `avg_order`) —
  agents and the UI reference them by `Cube.member`.

See the full working example in
[`examples/example.yml`](https://github.com/distri-ai/spyglass/blob/main/examples/example.yml),
or let [distri generate cubes](./generating-cubes.md) from your own database.
