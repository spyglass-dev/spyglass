# Reporting skills (for distri agents)

Generic, domain-agnostic skill definitions that make a distri agent build and
edit **Spyglass reports** from natural language. They pair with the frontend
tools exported by `@spyglass/ui` (`buildReportTools(host)` →
`create_report` + `add_report_widget`) and the `ReportCanvas` component.

Deploy them to your workspace like any distri skill:

```bash
distri skills push skills/reporting/build-report.md
distri skills push skills/reporting/add-widget.md
distri skills push skills/reporting/refine-widget.md
```

Wire them to intents in your router agent, e.g.:

```
intent: report        → reporting_build
intent: build_widget  → reporting_add_widget
```

## The contract these skills assume

A **report** is one JSON: a `title` and an ordered list of **widgets**. A data
widget is **bound** — it carries a cube query (`measures` / `dimensions` /
`filters` / `timeDimensions`) that the host runs live. The agent authors widgets
using your model's members (`Cube.measure`, `Cube.dimension`) — discover them
from your `/meta` catalog (or `schema-to-cubes.md`).

Widget vocabulary (also `WIDGET_VOCAB` in `@spyglass/ui`):

- `bound` — `{ type:"bound", as:"metric"|"table"|"chart", query, title?, w?, label?, format?, mark?, x?, y? }`. Prefer this for data.
- `metric` / `table` / `chart` — static (data inline). `note` — markdown.

The agent NEVER renders report data as chat text — the tools put it in the
product. The final chat message is one short line.
