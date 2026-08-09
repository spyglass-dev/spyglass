---
id: widgets
title: Widgets & reports
sidebar_position: 7
---

# Widgets & reports

Spyglass ships an embeddable React layer (`@spyglass/ui`) for turning query results into
**reports** — saveable, exportable documents of data widgets. Widgets are
**fully JSON-expressible**: a widget carries the data it renders, so a report is
one serializable document the agent emits, the host stores, and the UI renders.

## Widgets

| Type | Renders |
|------|---------|
| `metric` | a single headline number |
| `table` | `DataGrid`: server-driven sort/paging, CSV, virtualization |
| `chart` | a `bar` / `line` / `area` / `progress` mark |
| `note` | markdown narrative |
| `pivot` | rows × columns × one measure, from a flat group-by result |
| `custom` | a host-registered component (host defines the data format) |

The package is dependency-light and inline-styled, so the same widgets render in
the Studio and embed in any host app.

### DataGrid: sort and paging are query deltas

`DataGrid` (replacing the old static `DataTable`, which remains as an alias)
renders `table` widgets. Its defining rule: **sort and paging write query
deltas, never client-side array operations.** A header click emits
`{ order: [{ member, desc }], offset: 0 }`; the pager emits `{ offset }`. The
host applies the delta to the widget's cube query (`applyGridDelta`) and
re-runs it — so sorting reorders *all* rows, not the visible page, and
"1–25 of 312" reads the engine's `include_total` count. `ReportCanvas` wires
this automatically for bound widgets; standalone use passes `onQuery`.
Without `onQuery` the grid renders static data — no sort affordances, no pager.

```json
{
  "type": "table",
  "columns": [ { "key": "Orders.customer_id", "label": "Customer" } ],
  "rows": [ ... ],
  "total": 312,
  "page": { "offset": 25, "limit": 25 },
  "sort": { "key": "Orders.revenue", "desc": true },
  "bars": "Orders.revenue"
}
```

- **Label resolution** — a `"{member}__label"` column (the engine's label
  auto-projection) is hidden and its text renders inside the base column, so
  UUIDs display as names while sort/filter still act on the id.
- **`truncatedAt`** — set from the engine's row cap; the grid says "results
  truncated at N rows" instead of presenting a cutoff as the whole story.
- **CSV** exports the *loaded* rows (the current page), labels resolved.
- **Virtualization** — past 200 rows only the visible window mounts
  (fixed-height rows, no dependencies).
- `bars` draws proportional in-cell bars for one measure column.

### Theming: one token layer

Every color the widgets paint routes through `var(--rpt-*, fallback)` custom
properties (`tokens` export): `--rpt-bg`, `--rpt-muted`, `--rpt-border`,
`--rpt-text`, `--rpt-text-muted`, `--rpt-text-faint`, `--rpt-accent`,
`--rpt-accent-soft`, `--rpt-positive`, `--rpt-negative`. Define any of them on
an ancestor to restyle the whole widget set; with none defined the stock light
theme renders. No CSS import, no Tailwind required.

### Pivot: a missing cell is not a zero

The pivot is a **rendering**, not a query feature — the engine knows nothing
about it. The same two-dimension group-by that feeds a table feeds a pivot:

```json
{
  "type": "pivot",
  "rows": ["Reviews.customer_id"],
  "cols": ["Reviews.film_id"],
  "measure": "Reviews.avg_rating",
  "data": [ { "Reviews.customer_id": "c1", "Reviews.film_id": "f1", "Reviews.avg_rating": 4 } ],
  "totals": { "row": "avg", "col": "avg" },
  "scale": "sequential"
}
```

- `rows` / `cols` — dimension members forming the axes; headers prefer the
  `"{member}__label"` companion column when the data carries one (the engine's
  label auto-projection produces it).
- Cells distinguish **three states**: an *absent* combination renders `—`
  (or `0` with `empty: "zero"`), a *present-but-null* measure renders `n/a`,
  and a real `0` renders as `0`. Conflating these is how a matrix lies —
  "never attempted" and "scored zero" are different facts.
- `totals` adds edge aggregates (`avg`/`sum` per edge). They aggregate the
  values that exist; absent cells join in only under `empty: "zero"`, null
  never does.
- `scale` opts into cell shading: `sequential` ramps min→max, `diverging`
  splits around the midpoint. Off by default.
- The pivot caps at **60 rows × 24 columns** and says how much it cut —
  it truncates visibly, never silently.

In the query-builder, choose *Pivot* with two group-bys and one measure:
the first dimension becomes rows, the second columns. With fewer than two
dimensions the draft degrades to a plain table.

## Report doc

A report is `{ title, widgets: WidgetSpec[] }`. Widgets lay out on a **4-column
grid** via each widget's `w` (1–4). A typical layout: a `metric` row of headline
numbers up top, then `chart` / `table` widgets, with `note`s for narrative.

```json
{
  "title": "Orders overview",
  "widgets": [
    { "type": "metric", "w": 1, "title": "Revenue", "value": 128400 },
    { "type": "chart", "w": 3, "chart": { "mark": "bar", "x": "status", "y": "count", "series": [{ "status": "paid", "count": 12 }] } },
    { "type": "note", "w": 4, "markdown": "Revenue up 12% week over week." }
  ]
}
```

## Report filters: `applyFilters` returns a receipt

Report-wide filters (a date range + facet selections) are merged into each
bound widget's query by `applyFilters(widget, filters, cubeCaps)`. It returns
`{ query, applied }` — the merged query **and** which filters actually reached
it:

```ts
interface AppliedFilters {
  facets: string[]          // facet keys pushed into the query as IN filters
  dateRange?: string        // member the date range landed on, e.g. "Orders.created_at"
  dateRangeSkipped?:        // set when an ACTIVE range did NOT reach this widget:
    | 'no_time_field'       //   the cube declares no time field
    | 'opted_out'           //   the widget opted out (filters.ignore / dateField: null)
    | 'widget_pinned'       //   the query already pins its own filter on that member
    | 'unknown_cube'        //   the host declared no capabilities for the cube
}
```

The receipt exists because the worst filter bug is a silent one: a widget that
ignores the report's date range *looks* identical to one that honors it.
`resolveReport`/`resolveBound` attach `applied` to every resolved widget spec,
so a widget frame can render an explicit "all time" marker for any widget the
range could not reach, instead of presenting mixed windows as one report.

## Building reports with distri

The bundled [`reporting`](https://github.com/spyglass-dev/spyglass/blob/main/skills/reporting.md)
skill teaches an agent to: discover the cubes, run scoped queries via the
endpoint, map each result into a widget, and save the report doc — never pasting
raw data into chat.

## Studio

**Studio** is the Spyglass UI — a React/Vite app that talks to spyglass-server
(`/meta`, `/query`, `/reports`). It has four tabs:

- **Cubes** — browse the catalog from `/meta` (every cube's measures,
  dimensions, and which one is the `tenant` key).
- **Build query** — pick a cube + measures/dimensions, run `/query` under the
  current scope, and add the result to a report.
- **Reports** — list the bound reports saved on the server and **run** them
  (resolving their queries live) for the chosen scope.
- **Editor** — edit a report's JSON with a live preview; persist to IndexedDB.

The **scope** box in the header is the tenant value applied to every cube's
`tenant: true` dimension (e.g. `store_id` for the Pagila demo, `workspace_id`
for a SaaS host) — it's discovered from `/meta`, not hardcoded. Leave it blank to
use each report's own default scope.

### Serving the UI

Studio is **embedded into `spyglass-server`** behind the `ui` feature — one
binary serves both the app (at `/`) and the APIs (same origin, no CORS):

```bash
make ui                                  # pnpm build studio + cargo build --features ui
./target/release/spyglass-server serve   # open http://127.0.0.1:8088
```

Without the `ui` feature, `/` serves a zero-build HTML explorer (the same
cubes / query / reports views, no Node required). For UI development, run the
Vite dev server with hot reload and a proxy to the API:

```bash
pnpm dev   # studio at http://localhost:5197, proxying /api → spyglass-server
```

Develop the widgets themselves in isolation with Storybook (`pnpm storybook`).

The JS packages form a **pnpm workspace** rooted at the repo. From the root:

```bash
pnpm install   # install ui + studio + web
pnpm dev       # run the studio app (Vite dev server)
pnpm storybook # develop @spyglass/ui widgets in Storybook (HMR)
pnpm build     # build every package
pnpm test      # @spyglass/ui tests
```
