---
id: widgets
title: Widgets & reports
sidebar_position: 7
---

# Widgets & reports

Spyglass ships an embeddable React layer (`@spyglassjs/ui`) for turning query results into
**reports** — saveable, exportable documents of data widgets. Widgets are
**fully JSON-expressible**: a widget carries the data it renders, so a report is
one serializable document the agent emits, the host stores, and the UI renders.

## Widgets

| Type | Renders |
|------|---------|
| `metric` | a headline number, with change, sparkline and target when asked |
| `table` | `DataGrid`: server-driven sort/paging, CSV, virtualization |
| `chart` | a `bar` / `hbar` / `line` / `area` / `arc` / `progress` mark, with optional `y2`, `target` and comparison series |
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
properties (the `tokens` export). Define any of them on an ancestor to restyle
the whole widget set; with none defined, the stock light theme renders.

| Token | Paints |
|---|---|
| `--rpt-bg` | widget card surface (default white) |
| `--rpt-muted` | table headers, total rows |
| `--rpt-border` | hairlines and card borders |
| `--rpt-card-shadow` | card shadow |
| `--rpt-text`, `--rpt-text-strong`, `--rpt-text-muted`, `--rpt-text-faint` | body, titles, labels, placeholders |
| `--rpt-accent`, `--rpt-accent-soft` | interactive affordances, in-cell bars, hover |
| `--rpt-positive`, `--rpt-positive-soft`, `--rpt-negative`, `--rpt-negative-soft` | change pills |
| `--rpt-chart-series` | comma-separated series colours (default: the CVD-validated palette) |
| `--rpt-chart-axis-text`, `--rpt-chart-grid`, `--rpt-chart-domain` | axis labels, gridlines, axis lines |
| `--rpt-warn-text`, `--rpt-warn-bg`, `--rpt-warn-border` | the unreachable-scope marker |

Point them at your design system's variables (`--rpt-bg: hsl(var(--card))`)
and charts, cards and pills follow your light and dark themes. Inputs, popovers
and menus (filter bar, date picker, query builder) use your Tailwind `bg-card`,
`border-border` and `text-foreground` classes, so they match the host's
surfaces. There is no CSS to import, but layout uses Tailwind utility classes:
add `node_modules/@spyglassjs/ui/dist/**/*.js` to your Tailwind `content`.

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

### Cards, metrics and charts

Every widget renders inside a **`WidgetCard`**: a white card with the title,
an optional description, and an export menu that appears on hover. While a
widget refetches, it keeps its last result at reduced opacity instead of
flashing a spinner.

A bound metric takes three options beyond its query:

```json
{
  "type": "bound", "as": "metric", "label": "Return rate", "w": 1,
  "query": { "measures": ["Orders.return_rate"] },
  "filters": { "compare": "previous_period" },
  "trend": true,
  "upIsGood": false
}
```

- `filters.compare` (`previous_period` or `previous_year`) adds the change
  under the number: a percentage for amounts, points (`pt`) for rates.
- `trend: true` draws a sparkline of the measure across the report's window.
- `upIsGood: false` colours a rise red, for return rate, cost and churn.
- `target: { value, label }` turns the tile into a goal meter.

A bound chart takes:

- `y2`: a second measure drawn as a line on a right-hand axis (revenue bars
  with a margin line).
- `target: { value, label }`: a horizontal reference line.
- `height`: plot height in px (default 240; horizontal bars size by row).
- `filters: { compare: "previous_year" }` on a time series: last year as a
  dashed ghost series.

An unfinished last period (this week, when the week is half over) is drawn as
a dotted segment, not as a drop. Clicking a category drills the rest of the
report (see Drill below), and the clicked category stays highlighted.

Titles, formats and descriptions come from the model. Pass `meta` through
`memberIndex(meta)` (or the `useReportMembers` hook) and widgets pick up
`title`, `format` and `description` for every member, so the JSON only states
what differs.

### Exporters: a registry, not a menu

Exports are plain objects a host can add to, replace or drop. A
`WidgetExporter` is `{ id, label, applies(spec), run(ctx) }`, and the card
lists every exporter whose `applies` says yes. A `ReportExporter` is
`{ id, label, run({ doc, title }) }` for a whole report.

| Built in | Does |
|---|---|
| `csvExporter` | the widget's full result as CSV, re-running the query for every page when the host passes `fetchAll` |
| `pngExporter` | a chart as a 2× PNG on the widget's background |
| `jsonExporter` | copies the resolved widget spec |
| `markdownReportExporter` | the report as Markdown: metrics as a list, grids as tables |
| `jsonReportExporter` | the resolved report doc |

```tsx
import { ReportView, DEFAULT_WIDGET_EXPORTERS, type WidgetExporter } from '@spyglassjs/ui'

const pdf: WidgetExporter = { id: 'pdf', label: 'Download PDF', applies: () => true, run: myPdfPipeline }
<ReportView doc={doc} exporters={[...DEFAULT_WIDGET_EXPORTERS, pdf]} />
```

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

### Pills and deltas

- **Score pills**: a percent-format measure column bands into a tinted pill
  (≥75 positive, ≥50 warning, below negative) automatically; a categorical
  column takes `pill: { value: tone }` (e.g. a status column), with unmapped
  values neutral. Per-member overrides ride `WidgetDraft.columns`.
- **Metric deltas**: a widget declaring `filters.compare:
  "previous_period" | "previous_year"` gets the engine's comparison window
  over the report's active date range; the metric renders the
  `__prev_<measure>` difference as a chip — "↓9.4pt vs previous period".

## Report filters: `applyFilters` returns a receipt

Report-wide filters (a date range + facet selections) are merged into each
bound widget's query by `applyFilters(widget, filters, cubeCaps)`. A widget
whose query carries its own `timeDimensions.dateRange` (a template's stored
default window) has it **replaced** by the report's range — the report filter
is the user's word; intersecting the two silently shows the wrong window.
`widget_pinned` remains for widgets that pin via explicit filters. It returns
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
in its title row. On a metric it sits under the value, where the comparison
would go, so it never covers the label. The chip reads **"All time"** for
`no_time_field` / `opted_out` / `unknown_cube` and **"Pinned range"** for
`widget_pinned`, with the precise reason in the tooltip and a `data-reason`
attribute for tests.

The two kinds look different on purpose. A deliberate opt-out (`opted_out`)
renders as quiet muted text with a clock, because on a row of lifetime totals
an amber pill on every tile hides the one that matters. A skip nobody asked
for (`no_time_field`, `unknown_cube`, `widget_pinned`) keeps the amber pill,
styled by `--rpt-warn-text`, `--rpt-warn-bg` and `--rpt-warn-border`.

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

`buildReportTools(host, ctx, config)` gives the agent `get_report`,
`create_report`, `add_report_widget`, `edit_report_widget`,
`remove_report_widget`, `move_report_widget`, `set_report_filters`,
`rename_report`, and, with the context to support them, `explore_data`,
`find_reference_queries` and `add_report_view`. Three behaviours keep an
agent honest:

- **Every build and edit check-runs what it placed.** With `ctx.runQuery`,
  the tool resolves each new or changed widget the way the canvas will (pass
  `ctx.cubeCaps` so the report's date window and facets apply) and returns
  `needs_fix` for any widget that failed or came back empty, including a chart
  whose every value is zero. The agent fixes them in the same turn instead of
  announcing a report that shows "No data".
- **A follow-up edits; it does not rebuild.** `create_report` refuses while a
  report with widgets is open, and points at the edit tools. Pass
  `new_report: true` only when the reader asked for a separate report.
- **Filters are selected, not baked in.** `create_report({ filters })` and
  `set_report_filters({ selected, datePreset })` pick facet values and the
  window, so a tagged class or workspace scopes the report through its filter
  bar.

Without `config.save`, `create_report` opens an unsaved draft and says so
(`saved: false`); the host saves when the reader does. Wrap the host's query
runner in `withRetry(runQuery)` to ride out a busy server (408/429/502/503/504,
timeouts, dropped connections) without retrying a query that is simply wrong.

Example queries ride on `/meta`: declare `examples` (`{ id, asks, query,
means?, widget? }`) and `anti_examples` on a cube, and `find_reference_queries`
retrieves them for the agent. The engine refuses to load a model whose example
names a member it does not declare.

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
pnpm storybook # develop @spyglassjs/ui widgets in Storybook (HMR)
pnpm build     # build every package
pnpm test      # @spyglassjs/ui tests
```
