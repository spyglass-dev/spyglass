---
name: reporting_add_widget
description: "Add ONE widget to the report the user is already viewing, from a natural-language description. Use when the request is 'add a widget', 'add a chart of X', or comes from the report's Add-widget dialog (intent: build_widget)."
tags:
  - spyglass
  - reporting
---

# Add a widget

The user asked (usually from the report's "Add widget" dialog) for ONE widget,
in plain words, to be added to the report they're already viewing. This is a
DIFFERENT flow from building a whole report.

- Build exactly ONE widget and call **`add_report_widget`** with it — it appends
  to the open report and renders there with loading.
- **Never ask for scope.** The report is already open and the workspace scope is
  injected by the host. If the message carries an entity id
  (`class_id` / `student_id` / `activity_id`), add that entity filter; if it has
  none, build a workspace-scoped widget with NO entity filter. Just build it.
- Do NOT create or rebuild the report, run a plan, or write todos.
- Do NOT print the widget JSON in chat — the ONLY way it appears is via
  `add_report_widget`.
- Use the widget vocabulary (a `bound` widget with `query.measures` /
  `query.dimensions`). Never invent fields like `metrics` / `group_by` /
  `aggregation`.
- Finish with one short `final`, e.g. "Added an average-score table."

```json
{ "widget": { "type": "bound", "as": "chart", "title": "Avg score by student",
  "mark": "bar",
  "query": { "measures": ["Scores.avg_score"], "dimensions": ["Scores.student_id"] } } }
```
