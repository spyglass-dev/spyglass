---
name: reporting
description: "Author and update analytics REPORTS against the reporting engine. Discover available cubes (metrics/measures/dimensions), run scoped queries via the reporting endpoint, and lay out the results as a report doc of JSON widgets (metric/table/chart/note + custom). The report is saved/rendered in the product, never pasted into chat."
tags:
  - reporting
  - analytics
  - report
---

# Reporting

You build **reports**: saveable, exportable documents of data widgets. Data
comes from the **reporting engine** — a Cube-style semantic layer. You never
write raw SQL and never touch raw tables; you query *measures* and *dimensions*
and the engine compiles + scopes the SQL. The host pins the tenant scope
(e.g. a workspace/account/store) — you cannot widen it.

## Concepts

- **Cube** — a queryable entity (e.g. `Orders`) with **measures**
  (aggregations: `count`, `revenue`, `avg_order`, …) and **dimensions**
  (group-by/filter columns: `status`, `region`, `created_at`, …). The host
  defines the cubes; discover them from the model.
- **Query** (Cube-shaped JSON):
  ```json
  {
    "measures": ["Orders.count", "Orders.revenue"],
    "dimensions": ["Orders.region"],
    "filters": [{ "member": "Orders.status", "operator": "equals", "values": ["paid"] }],
    "timeDimensions": [{ "dimension": "Orders.created_at", "granularity": "week", "dateRange": ["2026-01-01","2026-02-01"] }],
    "limit": 100
  }
  ```
- **Widget** (JSON, fully expressible — see `@spyglass/ui`): `metric`,
  `table`, `chart` (mark `bar|line|area|progress`), `note` (markdown), or
  `custom` (host-defined). A widget carries the **data** it renders; you map a
  query result into a widget.
- **Report doc** — `{ title, widgets: WidgetSpec[] }`; widgets lay out on a
  4-column grid via each widget's `w` (1–4).

## Recipe

1. **Discover** the cubes available (the host lists them) and pick the measures
   + dimensions that answer the request. Don't invent member names — use what
   the model declares.
2. **Query** the reporting endpoint for each data widget. Keep queries small
   and purposeful; one query can feed one widget.
3. **Lay out** the report: a `metric` row up top (the headline numbers the
   reader cares about — totals, rates, averages, outliers), then `chart`/`table`
   widgets, with `note`s for narrative.
4. **Save** the report doc in the product. Acknowledge with a one-line `final`;
   never dump the data as text in chat.

## Tool order: recognise → verify → build

When the host registers the report tools (`@spyglass/ui`'s `buildReportTools`),
the order they are used in is part of the contract, not a preference:

1. **`find_reference_queries`** — FIRST, before composing anything. The model
   carries verified examples of its own use, with what each one *means* and how
   it wants to be rendered. Starting from the closest example is faster and more
   accurate than composing from the member list. Read the `anti` entries it
   returns: those are plausible-but-wrong member choices — the mistake
   validation cannot catch, because both members are real.
2. **`explore_data`** — verify. An example is a starting point, not proof that
   today's data supports it. Look at the rows before you build a widget on them.
3. **`create_report`** / **`add_report_widget`** — build.

### Editing what is already on screen

If the user refers to the report in front of them — *"add a filter"*, *"make
that a bar chart"*, *"drop the last widget"*, *"reorder it"*, *"rename it"* —
call **`get_report`** first and then the one tool that does the job
(`edit_report_widget`, `remove_report_widget`, `move_report_widget`,
`set_report_filters`, `rename_report`). Rebuilding the whole report with
`create_report` throws away everything else the user had.

**Filters are declared, not baked in.** `set_report_filters` (and
`create_report`'s `facets`) declare what the filter bar OFFERS; the framework
applies the chosen values to every widget whose cube has that dimension. Writing
the filter into each widget query instead produces a report that cannot be
re-pointed and a filter bar that does nothing.

## Rules

- Pick measures/dimensions from the model; never raw SQL.
- The tenant scope is injected by the host — don't add workspace filters
  yourself, and don't attempt to query outside the pinned scope.
- Prefer a few clear widgets over a wall of numbers. Headline metrics first.
- A widget's data must match its spec (e.g. a `table` needs `columns` + `rows`
  whose keys match). Validate before saving.
