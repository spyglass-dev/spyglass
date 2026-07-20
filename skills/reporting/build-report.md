---
name: reporting_build
description: "Build a saveable analytics REPORT from a natural-language request — assemble live, cube-bound widgets (metrics, tables, charts) and open it in the report builder. Use when the user says 'build/make a report', 'weekly overview', 'dashboard for X', or wants something they can save and export."
tags:
  - spyglass
  - reporting
---

# Build a report

The user wants a **report** — a saveable, full-page analytics document — not a
one-off chat answer. Assemble it and hand off to the builder with
`create_report`. A report is a `title` + an ordered list of **widgets**; data
widgets are **bound** (they carry a cube query the host runs live).

## Recipe

1. **Resolve scope.** Read the message header for any entity id
   (`class_id` / `student_id` / `activity_id` / …). The tenant/workspace scope is
   injected by the host — you only add entity filters. If you genuinely can't
   tell what to report on, ask one short question; otherwise proceed.

2. **Pick the widgets.** Choose 4–8 that answer the request, ordered
   headline-first: a KPI row (metrics), then a chart or two, then a table.
   Author each as a `bound` widget using your model's members. Example:

   ```json
   {
     "title": "Weekly overview",
     "widgets": [
       { "type": "bound", "as": "metric", "label": "To grade",
         "query": { "measures": ["Submissions.to_grade"], "filters": [{ "member": "Submissions.class_id", "operator": "equals", "values": ["<id>"] }] } },
       { "type": "bound", "as": "chart", "title": "Submissions by activity", "mark": "bar",
         "query": { "measures": ["Submissions.submitted"], "dimensions": ["Submissions.activity_title"],
                    "filters": [{ "member": "Submissions.class_id", "operator": "equals", "values": ["<id>"] }] } }
     ]
   }
   ```

3. **Build with `create_report`.** Pass the `title` + `widgets`. It opens the
   report builder; each widget resolves live (with loading) and the user can
   refine, filter, and export.

4. **Acknowledge with one line**, e.g. "Built your weekly overview — tweak and save."

## Rules

- Only add ENTITY filters; never a workspace/tenant filter (the host injects scope).
- Author queries with exact model members. If unsure which exist, discover them
  from the catalog — don't invent measures like `avg(score)` or fields like
  `group_by`.
- Never print widget/report JSON as chat text — `create_report` is the only way
  it appears. `final` is one short line.
- For a quick "how is X doing?" that doesn't need saving, this is the wrong
  skill — answer inline instead.
