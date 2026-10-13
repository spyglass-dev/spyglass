---
id: demo
title: Ask your data in the browser
sidebar_position: 1.5
---

# Ask your data in the browser

The demo in [`demo/`](https://github.com/spyglass-dev/spyglass/tree/main/demo)
is a report canvas with a distri analyst beside it, over a fictional
outdoor-gear store (Lighthouse Outfitters: two years of orders ending
yesterday, about 45k orders, 6,000 customers). There is no server and no
database. Ask a question, the analyst builds the widgets, click into a slice,
ask a follow-up, then save the report or export it.

<video
  src={require('@site/static/video/spyglass-demo.mp4').default}
  poster={require('@site/static/img/demo/video-poster.jpg').default}
  controls
  muted
  playsInline
  style={{ width: '100%', borderRadius: 12, border: '1px solid var(--ifm-color-emphasis-300)' }}
/>

## How it runs

```
cubes.yml + widget query ─▶ spyglass compiler (Rust → WASM) ─▶ SQL ─▶ DuckDB-WASM ─▶ rows
                                 the same plan_run / assemble_run as the Postgres engine
```

- `seed.sql` generates the tables inside DuckDB-WASM when the page loads
  (about 250 ms). The generator is hash-seeded, so every visitor sees the same
  numbers.
- Each widget query goes through the spyglass compiler, built to WebAssembly
  from the same crate the server uses. The compiler emits SQL, DuckDB runs it,
  and the compiler assembles the result (totals, row cap, the previous period
  for comparisons). A report means the same thing here as against a spyglass
  server.
- The analyst is a distri agent
  ([`agents/spyglass_analyst.md`](https://github.com/spyglass-dev/spyglass/blob/main/demo/agents/spyglass_analyst.md)).
  Its tools (`create_report`, `add_report_widget`, `edit_report_widget`,
  `set_report_filters`, `explore_data`, and the rest) come from
  `buildReportTools` and run in the browser against the open report. The model
  never sees SQL or table names, only the cube vocabulary.
- Saved reports live in IndexedDB through `createReportStore`.

Swap the browser engine's `runQuery` for a `fetch` to a spyglass server and
nothing above it changes. That is how a product embeds the same canvas and
tools over its own data. The step-by-step version, from boot to a click to an
export, is in
[`demo/HOW-IT-WORKS.md`](https://github.com/spyglass-dev/spyglass/blob/main/demo/HOW-IT-WORKS.md).

## What it shows

**A report.** The starter "Store overview" has four KPI tiles with a sparkline
and the change against the previous period, revenue by week with last period as
a dashed line, and revenue by channel. Titles, formats and descriptions come
from the model, not from the widget.

![Store overview](/img/demo/01-store-overview.png)

**One filter, every widget.** Picking a channel in the filter bar narrows every
widget the filter can reach. Here, Email: revenue goes from $1.9M to $327K.

![Filtered to Email](/img/demo/03-filtered-email.png)

**Ask a question.** "New report" opens an empty canvas with starter questions.

![Ask a question](/img/demo/04-ask-empty-state.png)

The analyst explores the data first, then builds the report and answers in two
sentences. Asked "Which channels convert best, and how does mobile compare to
desktop?", it built conversion tiles per device, conversion by channel and a
channel × device table, and answered "Email converts best at 4.59%… desktop is
about 1.8× higher."

![The analyst's report](/img/demo/05-analyst-report.png)

**The data.** The Data tab shows the generated tables and the model the analyst
reads.

![The data tab](/img/demo/07-data-tab.png)

## Run it

```sh
pnpm install
pnpm --filter @spyglass/demo wasm   # needs wasm-pack + the wasm32-unknown-unknown target
cp demo/.env.example demo/.env      # DISTRI_API_KEY / DISTRI_WORKSPACE_ID for the analyst
distri agents push demo/agents/spyglass_analyst.md
pnpm --filter @spyglass/demo dev    # http://127.0.0.1:5198
```

Without `DISTRI_API_KEY`, the report, filters, drilling and exports still work,
and the analyst panel says what is missing. The key stays in the Vite dev
server, which mints short-lived tokens at `POST /api/token`. Add `?smoke` to the
URL to run the engine self-test (buckets, compare, gap fill, labels, records).
