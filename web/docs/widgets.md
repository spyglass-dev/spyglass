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
| `note` | markdown narrative — the base renderer covers headings, `**bold**`, `*italic*`/`_italic_` and `` `code` `` without dependencies; register a `note` custom widget for full markdown |
| `pivot` | rows × columns × one measure, from a flat group-by result |
| `custom` | a host-registered component with frozen data |
| `view` | a host-registered component **bound to a query** — live, filtered, drillable |

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

### Drill: model-driven clicks

Drill belongs to the **model**, not the UI: cubes annotate dimensions with
`drill: { entity }`, and every table in every report becomes drillable with no
per-report wiring.

- **Dimension cells emit `DrillEvent`** — `{ member, value, label?, entity? }`
  (the label comes from the engine's `__label` projection; the entity from
  the result column's `drill_entity`, which the engine stamps straight from
  the dimension's `drill: { entity }` annotation — no client-side `/meta`
  join). The host may register a `DrillRouter` (`Record<entity, handler>`)
  on `ReportCanvas`; routing is host policy, emitting is framework behavior.
- **With no router — or no route for the entity — the default is
  drill-DOWN**: the value becomes an `equals` filter, every widget whose cube
  shares the dimension re-runs in place, and a **poppable breadcrumb**
  (`All ▸ customer: Karl Seal ▸ status: paid`) records the trail. Popping a
  segment truncates the trail — drill-down's undo. The trail lives on the
  report doc (`report.drill`), so it saves and shares like any other state.
- **Measure cells open row mode**: clicking one runs the widget's
  fully-filtered scope, narrowed to the clicked row, as a `mode: 'rows'`
  query, and shows the records in a drawer. The engine projects only the
  cube's `drill_members` — and refuses a cube that declares none — so the
  drawer is PII-bounded by the model, not the UI.
- **URL state**: `reportStateToSearch` / `parseReportSearch` serialize
  filters, drill trail, page and sort into one `?rpt=…` parameter — a copied
  link reproduces the exact view. `ReportCanvas syncUrl` wires it via
  `history.replaceState`; hosts with routers call the helpers themselves.
  A default view serializes to nothing, and a garbage parameter degrades to
  the default view, never a crash.

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
- `totals` adds edge aggregates. `avg`/`sum` fold the CELL values that exist
  (absent cells join in only under `empty: "zero"`, null never does). A
  **`ratio` total** — `{ "ratio": { "num": "Reviews.points", "den":
  "Reviews.possible", "scale": 100 } }` — divides two other measures summed
  over the same slice. Use it whenever the cell measure is itself a ratio: a
  mean of per-cell percentages is not a weighted total (with uneven
  denominators it inflates small cells — the classic gradebook lie at the
  totals edge), and the grand total re-derives from all source rows rather
  than averaging the edge.
- **Cells are drill targets**: a present cell keeps its source data row —
  which carries both axis dimension values — and `Pivot onMeasureClick` hands
  it back on click, the same contract as a table's measure click. On
  `ReportCanvas` that opens the records drawer narrowed to the exact cell.
  Absent cells have no row and are not drill targets.
- `scale` opts into cell shading: `sequential` ramps min→max, `diverging`
  splits around the midpoint. Off by default.
- The pivot caps at **60 rows × 24 columns** and says how much it cut —
  it truncates visibly, never silently.

In the query-builder, choose *Pivot* with two group-bys and one measure:
the first dimension becomes rows, the second columns. With fewer than two
dimensions the draft degrades to a plain table.

`totals.rowLabel` / `totals.colLabel` name the edge totals in the domain's
words — a gradebook says "Average" and "Class average", not the generic
Total/Avg. The pivot also footers its axis counts ("6 students · 4
activities" — the axis dimension's humanized noun) and, when `scale` shading
is on, a low→high legend beside the absent-cell marker.

Charts ship a quiet default theme — recessive axes and grid, thin rounded
bars, straight ellipsis-truncated category labels, and a CVD-validated
categorical palette (`CHART_SERIES`) assigned in fixed order. A raw `vlSpec`
carrying its own `config` overrides the theme wholesale. Table and metric
headers derive from `humanizeMember` — `Cube.activity_id` renders as
"Activity" (ids defer to their `label:` companions for values).

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

On `ReportCanvas`, a host that passes `onEditWidget` gets an Edit affordance on
**bound widgets and notes** — a note is authored prose (a summary, an
annotation), so the host can offer a plain text editor for it rather than a
query flow. Static data-bearing specs and views have nothing hand-editable and
get no Edit button.

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

### The "all time" marker

Both frames (`ReportView` and `ReportCanvas`) render the receipt: any widget
whose resolved spec carries `applied.dateRangeSkipped` gets an **`AllTimeChip`**
in its title row (title-less metrics get a marker row of their own). The chip
reads **"All time"** for `no_time_field` / `opted_out` / `unknown_cube` and
**"Pinned range"** for `widget_pinned`, with the precise reason in the tooltip
and a `data-reason` attribute for tests. Styling comes from three tokens:
`--rpt-warn-text`, `--rpt-warn-bg`, `--rpt-warn-border`.

Two practices keep the marker meaningful:

- A widget that is *deliberately* all-time (a lifetime total beside ranged
  widgets) should say so — `filters: { ignore: true }` — so its chip reflects a
  choice rather than a hole in the model.
- Hosts should regression-test their shipped templates: rendered with an
  active date range, they should produce **zero involuntary chips**
  (`no_time_field` / `unknown_cube`). That test is what stops the
  missing-time-field bug from recurring the next time someone adds a cube.

## Bound views: live product widgets, not an escape hatch

A `custom` widget carries frozen data. A **view** is a host React component
**bound to a query**, resolved by Spyglass like any bound widget:

```json
{ "type": "view", "component": "leaderboard",
  "query": { "measures": ["Payments.revenue"], "dimensions": ["Payments.rating"] },
  "props": { "measure": "Payments.revenue" } }
```

- `registerView(registry, manifest)` — the manifest carries `name`, `title`,
  `description`, a **data contract** (`requires` / `suggests` member keys), a
  `propsSchema`, and the component. The manifest is what puts a view in the
  model digest (`modelDigest(meta, views)`) and lets an agent place it by
  name (`add_report_view`, validated against the manifest).
- The component receives **`ViewProps`**: the resolved `rows`/`columns`/`total`,
  the report `filters` in effect, the **`drill` callback** (views participate
  in drill like every table), `refresh`, and its own `props`. Views respect
  report scope and the drill trail — they are part of the system, not an
  escape hatch from it.
- **An unmet contract renders `widget_error`, never a blank cell** — same for
  an unknown component name.
- An *action widget* (a view with a mutation) is just a view whose component
  calls host APIs and then `refresh()`.

## Explore: text and chips edit one object

`Explore` is the workbench: an **ask bar**, a searchable **catalog rail**
(featured members first, descriptions and units from `/meta`), the query as a
**chip sentence** (`revenue ▸ by rating ▸ where store equals Store 1 ▸ top 25`),
an **auto-selected visualization** (1 measure → metric; granular time → line;
1 dimension → bar; 2 dimensions → pivot; else table — manual override always
available), and the **Explain panel** — the compiled SQL the engine has always
returned and no UI ever displayed, plus row count and timing.

The property that makes it work: **the ask bar and the chips edit ONE
`WidgetDraft`.** The host's `onAsk(prompt, current)` returns a draft; the
chips then edit that same object. Text is an editor of the document, never a
second authoring path.

Invalid queries never run: `validateQuery(query, meta)` returns
`{ ok: false, error, suggestions }` (closest member names), shown inline —
and used by agents to self-repair.

## The text layer: digest, explore_data, provenance

- **`modelDigest(meta)`** generates the agent-readable model description from
  `/meta` — featured members lead; descriptions, units, labels, drill
  entities, segments, joins and `drill_members` all ride along. Generated,
  never hand-written, so it cannot drift from the deployed cubes.
- **`explore_data`** (via `buildReportTools(host, { meta, runQuery })`) runs a
  query and returns a **compact summary** — columns, row count, total, first
  10 rows, compiled SQL — so an agent *looks before it builds*. A bad member
  returns `{ ok: false, error, suggestions }` for self-repair instead of a
  broken widget.
- **Provenance**: agent-built bound widgets carry
  `{ prompt, author: 'agent', at }` — part of the doc, not a side channel, so
  "why is this number here" always has an answer. `create_report` /
  `add_report_widget` accept a `prompt` parameter and validate bound queries
  against the model before rendering anything.

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
