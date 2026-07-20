---
name: reporting_refine
description: "Refine an existing report or widget from a natural-language change request — 'make it a bar chart', 'group by week', 'only failing students', 'add a column'. Re-emit the affected widget(s) through the report tools."
tags:
  - spyglass
  - reporting
---

# Refine a report / widget

The user is looking at a report and asked for a change in plain words. Translate
the change into an updated widget query/visualization and apply it through the
tools — never describe the change as chat text.

Common changes → what to edit on the `bound` widget:

- "make it a bar/line/area chart" → set `as: "chart"` + `mark`.
- "as a table" / "as a number" → set `as: "table"` / `as: "metric"`.
- "group by week/student/activity" → set `query.dimensions` (or a
  `timeDimensions` granularity for time).
- "only failing / graded / this class" → add a `query.filters` entry
  (`operator`: `equals` / `in` / `gt` / `lt` / `contains`).
- "sort by …", "top N" → `query.order` + `query.limit`.
- "add a column" → add a measure/dimension to `query`.

How to apply:

- Adding a NEW widget → `add_report_widget` with the single new widget.
- Changing the report as a whole (multiple widgets, different scope) →
  `create_report` with the full updated widget list.

Keep queries on your model's exact members; never invent fields. Acknowledge
with one short `final`.
