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
| `table` | `columns` + `rows` |
| `chart` | a `bar` / `line` / `area` / `progress` mark |
| `note` | markdown narrative |
| `custom` | a host-registered component (host defines the data format) |

The package is dependency-light and inline-styled, so the same widgets render in
the Studio and embed in any host app.

## Report doc

A report is `{ title, widgets: WidgetSpec[] }`. Widgets lay out on a **4-column
grid** via each widget's `w` (1–4). A typical layout: a `metric` row of headline
numbers up top, then `chart` / `table` widgets, with `note`s for narrative.

```json
{
  "title": "Orders overview",
  "widgets": [
    { "type": "metric", "w": 1, "title": "Revenue", "value": 128400 },
    { "type": "chart", "w": 3, "mark": "bar", "data": { "...": "..." } },
    { "type": "note", "w": 4, "markdown": "Revenue up 12% week over week." }
  ]
}
```

## Building reports with distri

The bundled [`reporting`](https://github.com/distri-ai/spyglass/blob/main/skills/reporting.md)
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
