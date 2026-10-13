# How the demo works

The demo is three pieces in one browser tab and one agent definition in distri.
This page follows a question from the chat box to the pixels, then a click,
then explains what changes when the same pieces run inside a product.

```
┌──────────────── browser tab ─────────────────────────────────────────────┐
│                                                                          │
│  Analyst panel ──tools──▶ Report (JSON) ──▶ ReportCanvas ──▶ widgets     │
│  (distri <Chat>)           ▲      │           │                          │
│        ▲                   │      │           ▼ runQuery(WidgetQuery)    │
│        │                   │      │      spyglass compiler (WASM)        │
│        │      explore_data │      │           │ SQL + params             │
│        │                   │      │           ▼                          │
│        │                   └──────┴──── DuckDB-WASM ◀── seed.sql tables  │
│        │                                                                 │
│        │ IndexedDB: saved reports      localStorage: the open report      │
└────────┼─────────────────────────────────────────────────────────────────┘
         │ messages + tool calls (SSE)
   distri cloud: the spyglass_analyst agent (agents/spyglass_analyst.md)
```

## Boot

`main.tsx` calls `createBrowserEngine` once per page:

1. Start DuckDB-WASM in a worker.
2. Load the spyglass compiler (`wasm/pkg`, about 1.4 MB) and build a model from
   `src/dataset/cubes.yml`. `meta()` returns the same catalog a spyglass server
   serves at `/meta`: cubes, measures with titles, formats and descriptions,
   dimensions with drill entities.
3. Run `src/dataset/seed.sql`. It generates Lighthouse Outfitters, a fictional
   outdoor-gear store: 6,000 customers, about 45,000 orders and 63,000 order
   lines over two years ending yesterday, plus daily web traffic. Every random
   draw is a hash of the row's key, so the data is the same on every machine.
   It takes about 250 ms.

The compiler must be initialized once. React StrictMode runs effects twice,
and a second init swaps wasm-bindgen's module global under objects the first
one created, which corrupts the heap a few queries later.

## A question

You type "Which channels convert best?".

1. **Context rides with the message.** `AnalystPanel` sends two dynamic
   sections with every turn: `dataset`, a digest generated from `meta()` by
   `useReportModel`, and `on_screen`, a one-paragraph description of the open
   report (title, date range, drill trail, each widget's id and status).
2. **The agent runs in distri; its tools run here.** The agent definition lists
   only browser tools (`external = [...]`). When it calls one, distri streams
   the call to the tab, `@distri/react` runs the handler from
   `buildReportTools`, and the result goes back to the agent.
3. **It looks before it builds.** `explore_data` runs a query through the same
   engine and returns 10 rows by default (100 at most). Typically two or three
   calls.
4. **It builds.** `create_report` or `add_report_widget` validates every query
   against the model first. An unknown member returns
   `{ ok: false, error, suggestions }` and the agent repairs it. Valid widgets
   are written into the report through `ReportHost.setReport`, which is React
   state in `App.tsx`.
5. **It reads what rendered.** Every tool result carries the report state and
   each widget's outcome (`ok` with a row count and sample, `empty`, `error`).
   An empty widget is the agent's bug to fix, and it does.
6. **It answers in two sentences** with the number. The report is the answer;
   the chat says what it shows.

## A widget, from JSON to pixels

A bound widget is plain JSON:

```json
{ "type": "bound", "as": "chart", "mark": "hbar", "title": "Conversion rate by channel",
  "query": { "measures": ["Traffic.conversion_rate"], "dimensions": ["Traffic.channel"],
             "order": [{ "member": "Traffic.conversion_rate", "desc": true }] } }
```

`ReportCanvas` resolves every widget on each change (`resolveReport`):

1. **Report filters merge in** (`applyFilters`). The date range becomes a
   `gte`/`lt` filter on the cube's time field, or the time dimension's window
   when the widget compares periods. Facets (region, channel…) become `in`
   filters on cubes that have that dimension. What was applied and what was
   skipped is recorded on the widget, never dropped silently.
2. **The drill trail merges in** (see below).
3. **`runQuery` runs it.** The browser engine asks the compiler for a plan:
   SQL plus parameters for the current window and, for a comparison, the
   previous one, both resolved against one clock. DuckDB executes the
   statements one at a time and the compiler assembles the result: the total
   count, the row cap, and `__prev_<measure>` columns for the comparison.
   These are the same `plan_run` and `assemble_run` functions
   `PostgresEngine::run` calls.
4. **The result becomes a renderable spec** (`draftToWidgetSpec`). Titles and
   formats come from the model, so `Traffic.conversion_rate` is "Conversion
   rate" in percent without the widget saying so.
5. **It renders** in a `WidgetCard`. Charts compile to Vega-Lite with tooltips
   whose text is formatted exactly like the table; metrics draw their
   sparkline from a second bucketed query run alongside the first.

## A click

Clicking the Email bar emits a `DrillEvent { member: "Traffic.channel", value:
"Email" }`. With no host router for that entity, the canvas appends it to the
report's drill trail and re-resolves.

- Every widget whose cube has a `channel` dimension gets
  `channel = 'Email'`: the metrics, the device breakdown, the pivot.
- The chart you clicked is broken down by channel, so it is not narrowed to a
  single bar. It stays whole and fades everything except Email.
- The trail shows as a removable chip in the filter bar, and the agent sees it
  in `on_screen`, so "why is this channel ahead?" is answered about Email.

A click on a measure cell opens the underlying records instead: the engine
runs the widget's scope in `mode: rows` and projects only the cube's
`drill_members`.

## Saving and exporting

- The open report is kept in `localStorage`, so a reload brings it back.
- **Save** writes it to IndexedDB through `createReportStore`, the same store
  interface a host backs with its own server.
- A widget's export menu downloads a CSV of the whole result (the query re-run
  without paging), a PNG of a chart, or copies the widget JSON. **Export** in
  the header downloads the resolved report as Markdown or JSON. Both menus are
  registries: a host passes its own `WidgetExporter` or `ReportExporter`.

## The distri connection

The browser never holds the distri API key. In dev, the Vite server answers
`POST /api/token` with a short-lived token that can read agents and run
completions, minted from `DISTRI_API_KEY` in `demo/.env`. A static deploy puts
the same endpoint behind a serverless function. Without it the demo runs with
the analyst panel explaining what is missing.

Push the agent after editing it:

```bash
distri agents push demo/agents/spyglass_analyst.md
```

## Inside a product

Nothing above the engine is demo code. A host keeps the canvas, the tools and
the agent, and changes three things:

| In the demo | In a host (zippy) |
|---|---|
| `runQuery` → WASM compiler + DuckDB in the tab | `runQuery` → `POST /admin/reporting/query`; the same compiler runs in Rust and scopes every query to the tenant |
| `meta()` from `cubes.yml` in the bundle | `/meta` from the host's cube files |
| reports in IndexedDB | reports in the host's `reports` table through the same store interface |

The browser engine also stays useful in a product: previewing a report over
sample data before real data exists, or answering from a downloaded extract
offline.
