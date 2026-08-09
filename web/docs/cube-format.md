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

Two presentation annotations ride on dimensions:

| Field | Meaning |
|-------|---------|
| `label` | member whose value is **displayed** for this dimension — typically a joined cube's name column for an id (`label: Customers.customer_name`), or an unqualified same-cube dimension |
| `drill: { entity }` | what a click on this value **means** — the entity it identifies (`customer`, `order`, …). The UI emits a typed `DrillEvent` carrying it |

A labelled dimension is auto-projected: selecting it adds a
`"{member}__label"` column (kind `label`) to the result, joining the label's
cube if needed. Sorting, filtering and grouping still act on the **id** — the
label is presentation only.

## Joins

A cube may declare joins to other cubes:

```yaml
Orders:
  sql_table: orders
  joins:
    Customers: { relationship: many_to_one, sql: "${CUBE}.customer_id = ${Customers}.id" }
```

- `relationship` is `many_to_one`, `one_to_one`, or `one_to_many`.
- In `sql`, `${CUBE}` is the declaring cube and `${Name}` any cube — both
  resolve to the cube's alias in the compiled SQL.

The compiler picks a single **base cube** — the cube owning the query's
measures (all measures must share one cube), or the first dimension's cube for
a measureless query — and traverses joins *away* from it as `LEFT JOIN`s,
multi-hop included.

**Only `many_to_one` and `one_to_one` edges are traversable.** A query that
would traverse a `one_to_many` edge fails with `FanOut` at compile time — it
would duplicate base rows and silently inflate every aggregate, and a wrong
number is worse than a missing capability. Declare the query on the many side
instead.

**Tenant scope applies to every cube in the join tree.** A joined cube that
declares a `tenant:` dimension contributes its own scope predicate, or the
query fails closed exactly like an unscoped single-cube query.

## Row mode boundary: `drill_members`

`drill_members` on a cube lists the members a row-level ("show me the
underlying records") query may project. It is deliberately also the **PII
boundary**: row mode can only ever reveal what the cube explicitly published.
A measure may declare its own `drill_members` to *narrow* the cube's list —
never to widen it. A cube without `drill_members` has no row mode.

## Measures

Measures are **aggregations**.

| `type` | Produces |
|--------|----------|
| `count` | row count (ignores `sql`) |
| `count_distinct` | distinct count of `sql` |
| `sum` / `avg` / `min` / `max` | aggregation over the numeric `sql` |
| `number` | a raw numeric `sql` expression with **no** aggregation wrapper |

For a **conditional count** ("rows meeting a condition"), use `sum` with a
`case` expression — a plain `count` ignores its `sql`:

```yaml
measures:
  paid: { type: sum, sql: "case when status = 'paid' then 1 else 0 end" }
```

Add `format: percent` on ratio measures so the UI renders them correctly.

## Curation

Five fields on both measures and dimensions tune what the catalog (`/meta`)
shows — curation is the difference between a catalog a human can browse and a
list of forty equal strings, and it is the only ranking signal an agent has:

| Field | Meaning |
|-------|---------|
| `description` | one sentence of definition, shown on hover and read by agents. "Average score" is exactly the kind of number that needs one |
| `featured: true` | surface this member first in catalogs and digests |
| `hidden: true` | omit from `/meta` entirely. The member stays **queryable by name** — hidden curates discovery, it is not security |
| `unit` | display unit (`orders`, `students`, `%`) |
| `filterable: true` | offer this dimension in filter UIs (and the distinct-values endpoint, once it exists) |

## Load-time validation

`load_dir` validates the **merged** model and refuses to load one with
dangling cross-references: a `joins:` target that isn't a cube, a `label:`
that doesn't resolve to a declared dimension, a `drill_members` entry that
isn't a dimension, or a measure whose `drill_members` widens the cube's list.
Every problem is reported at once. Hosts that embed a single parsed file
should call `Model::validate()` themselves after parsing.

## Calculated measures

A `number` measure's `sql` may interpolate other measures of the same cube
with `${CUBE.<measure>}` — resolved to the referenced measure's **compiled
aggregate expression**, recursively:

```yaml
measures:
  count: { type: count }
  published: { type: sum, sql: "case when published_at is not null then 1 else 0 end" }
  publish_rate:
    type: number
    sql: "${CUBE.published} / nullif(${CUBE.count}, 0) * 100"
    format: percent
```

Only declared members interpolate (injection-safety by construction), only
in `number` measures (aggregates cannot nest), and cycles are refused at
load time. Calculated measures work everywhere a measure does — including
`HAVING` filters.

## Segments

Named reusable predicates on a cube — one token for an agent instead of a
filter blob, and a place to put business definitions so they stop being
re-derived per report:

```yaml
segments:
  active: { sql: "${CUBE}.archived_at is null", description: Items not archived. }
```

Queried as `{ "segments": ["Items.active"] }`; each compiles parenthesized
into `WHERE`. A segment's cube participates like any referenced cube —
joins are planned and its tenant scope is enforced. The catalog exposes
segment names + descriptions, never the SQL.

## The tenant rule

Every cube that holds tenant data **must** expose a dimension marked
`tenant: true` (commonly `workspace_id` or `tenant_id`). The host pins the scope
via the [`SecurityContext`](./querying.md#scope) and Spyglass injects it as a
mandatory `WHERE` filter on every query. A cube without a tenant dimension can't
be safely queried in a multi-tenant deployment.

## File forms the loader accepts

The loader (it reads every `*.yml` / `*.yaml` / `*.json` in a directory and
merges them) accepts three equivalent shapes:

1. **`cubes:` map** (above) — keyed by cube name.
2. **Canonical Cube list form** — `cubes`, `dimensions`, and `measures` as
   sequences of `{ name, … }`. This is what [Cube](https://github.com/cube-js/cube)
   emits, and what a distri agent may generate; it loads as-is:

   ```yaml
   cubes:
     - name: Orders
       sql_table: orders
       dimensions:
         - { name: tenant_id, type: string, sql: tenant_id, tenant: true }
       measures:
         - { name: count, type: count }
   ```
3. **Single cube per file** — a top-level `name:` with no `cubes:` wrapper.

The name comes from the map key (form 1) or the `name:` field (forms 2–3).

## Rules of thumb

- **Never invent columns** — use only what the schema actually has.
- Conditional counts go through `sum(case when … then 1 else 0 end)`.
- Keep measure/dimension names **stable and human** (`revenue`, `avg_order`) —
  agents and the UI reference them by `Cube.member`.

See the full working example in
[`examples/example.yml`](https://github.com/spyglass-dev/spyglass/blob/main/examples/example.yml),
or let [distri generate cubes](./generating-cubes.md) from your own database.
