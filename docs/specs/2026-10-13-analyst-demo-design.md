# Ask-your-data demo and widgets that hold up

Status: building · 2026-10-13

## Why

The reporting widgets render correct numbers that read badly: raw member names
in headers ("Aov"), USD hard-coded, a fixed 220px chart with default Vega
tooltips (`Orders.revenue: 589210.0000000038`), charts you cannot click, a
metric tile with no trend, one spinner for the whole report. There is also no
way to show spyglass working without a server, a database and a host app.

Two outcomes:

1. **A demo that lives in this repo only**: a distri analyst agent next to a
   report canvas, over a dataset that lives in the browser. Ask a question, the
   agent builds widgets, click a bar to drill, the agent sees the drilled
   report and refines it, save it, export it. The same shape as distrijs
   `samples/maps-demo` (a surface with an imperative API, tools over that API,
   `<Chat>` beside it).
2. **Widgets good enough that the demo is the pitch**, built in `@spyglassjs/ui`
   so zippy gets them by bumping a version.

## Architecture

```
cubes.yml + WidgetQuery ─▶ spyglass compiler (Rust → WASM) ─▶ SQL ─▶ DuckDB-WASM ─▶ rows
                                 same plan_run / assemble_run as PostgresEngine
```

- `src/engine/run.rs` holds the driver-agnostic half of a run: row cap, the
  `compare` window against one clock, and result assembly (`total`,
  `truncated_at`, `__prev_*`). `PostgresEngine::run` uses it; so does the WASM
  build. A report therefore means the same thing against a server and against
  a dataset in a tab.
- `wasm/` (`spyglass-wasm`): `new Spyglass(yaml)`, `meta()`, `plan(query)`,
  `assemble(id, rows, prev)`, `values(member)`.
- The compiler's Postgres dialect runs on DuckDB unchanged (`$n` placeholders,
  `::type` casts, `date_trunc`, `generate_series`). Verified by `?smoke`:
  10/10 cases including compare, fill_gaps, labels, rows mode.
- `demo/` (`@spyglass/demo`, private): Vite + React. The dataset is
  `seed.sql`, a deterministic generator (a fictional outdoor-gear store, two
  years ending yesterday, ~45k orders) that runs inside DuckDB in ~250 ms.
  Saved reports live in IndexedDB through `createReportStore`.

The client-side tools already exist (`buildReportTools`, `useReportModel`); the
demo binds them to the browser engine exactly as zippy binds them to `/query`.
That is the "distri approach": tools in the client, the Rust engine as the
middleware that compiles and scopes.

## Widget work (in `@spyglassjs/ui`)

| Area | Today | After |
|---|---|---|
| Labels and formats | member names humanized; format only if the widget says | resolution reads the model (`meta`): titles, `format`, `unit` flow into headers, axes, tooltips. Currency code configurable |
| Chart | fixed 220px, default tooltips, no click | formatted tooltips, `height`, click to drill on categories, previous-period ghost series, `target` reference line, bar + line combo (`y2`), theme-aware ink, selected-category highlight |
| Metric | number + absolute delta | sparkline, percent change pill, comparison label, `target` progress |
| Table | correct, plain | formatted cells by column format, in-cell bars on measures by default, hover, keyboard-reachable drill cells |
| Frame | title floats above, no card | one widget card: title, description, export menu, stale-while-refreshing |
| Export | page-only CSV in the grid | pluggable `WidgetExporter` / `ReportExporter` registry: CSV, PNG (charts), JSON, Markdown built in; hosts register more (zippy's PDF/DOCX `DocumentBlock` pipeline is one) |
| Bugs | pivot never reports `empty`; agent vocab rejects static `pivot`/`custom` | fixed |

## How it lands in zippy

Nothing in zippy changes shape. zippy already passes a `runQuery` (its
`/admin/reporting/query`) and the same tools; it bumps `@spyglassjs/ui`, passes
`meta` into resolution, and gets the new chart/metric/card/export behaviour.
Superadmin first (the analyst panel and report pages), teachers after. zippy's
PDF/DOCX export registers as a `ReportExporter` instead of living beside the
canvas. The browser engine is also a fit for zippy's offline/preview cases
(a teacher previewing a report over a sample before data exists), but that is a
later decision.

## Out of scope for this pass

Drag/resize layout, scheduling, alerts, bring-your-own CSV (the engine supports
it; the UI does not yet), moving the report store into Rust (#432).
