---
id: react
title: Ask your data in a React app
sidebar_position: 2
---

# Ask your data in a React app

This guide adds an "ask your data" panel to an existing React app. A user types a
question, an agent builds a report on the page (metrics, charts, tables), and every
query it runs is compiled by Spyglass with the user's tenant scope. The agent never
writes SQL and never sees table names.

You need three things:

1. **A model**: your data described as cubes (measures and dimensions) in YAML.
2. **A reporting endpoint**: `GET /meta` and `POST /query`, served by your backend.
3. **The React side**: `@spyglassjs/ui` for the report, and an agent whose tools run
   in the browser.

The [browser demo](./demo.md) is all three in one tab, and its source
([`demo/`](https://github.com/spyglass-dev/spyglass/tree/main/demo)) is the most
complete example. This page is the short path.

## 1. Describe your data

Write one YAML file per cube. Mark the column that scopes rows to a customer with
`tenant: true`; a query on that cube will not compile without it.

```yaml
cubes:
  Orders:
    sql_table: orders
    dimensions:
      tenant_id:  { type: string, sql: tenant_id, tenant: true }
      status:     { type: string, sql: status }
      channel:    { type: string, sql: channel }
      created_at: { type: time,   sql: created_at }
    measures:
      count:   { type: count }
      revenue: { type: sum, sql: amount_cents, title: Revenue, format: currency }
```

Titles, formats and descriptions here are what the widgets show and what the agent
reads, so write them for a person. To draft cubes from an existing database, see
[Generating cubes](./generating-cubes.md).

## 2. Serve the reporting endpoint

The endpoint has two routes the React side needs: `GET /meta` (what can be asked)
and `POST /query` (run a query). You can get them two ways.

**Embed the crate in your backend (recommended).** Your backend owns the database
client and builds the `SecurityContext` from the logged-in session, so the tenant
never comes from the browser. See [Embedding: the engine](./embedding.md#1-the-engine-in-process-rust).

**Run `spyglass-server` behind your backend.** Quicker to try:

```bash
cargo install --git https://github.com/spyglass-dev/spyglass spyglass
REPORTING_CUBES=./cubes DATABASE_URL=postgres://... spyglass-server serve
```

The standalone server has no authentication and reads the scope from the request,
so do not expose it to browsers directly. Put it behind your own API, which adds the
scope for the signed-in user. A Postgres read replica is a good database to point it at.

In development, proxy it so the browser talks to one origin (Vite shown):

```ts
// vite.config.ts
server: {
  proxy: { '/api': { target: 'http://127.0.0.1:8088', changeOrigin: true,
                     rewrite: (p) => p.replace(/^\/api/, '') } },
}
```

## 3. Render a report

```bash
pnpm add @spyglassjs/ui     # peers: react, react-dom, lucide-react
```

A `ModelClient` is two functions: fetch the catalog and run a query. Map your
endpoint's response here if it differs from Spyglass's.

```ts
import type { ModelClient } from '@spyglassjs/ui'

export const client: ModelClient = {
  fetchMeta: () => fetch('/api/meta').then((r) => r.json()),
  runQuery: (query) =>
    fetch('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query),
    }).then((r) => r.json()),
}
```

`ReportCanvas` renders a report and runs its widgets' queries. A report is plain
JSON (`{ title, widgets }`), so you can keep it in state, a URL or your database.

```tsx
import { useRef, useState } from 'react'
import { ReportCanvas, type Report, type WidgetOutcome } from '@spyglassjs/ui'
import { client } from './spyglass'

export function Reports() {
  const [report, setReport] = useState<Report>({ title: 'Untitled report', widgets: [] })
  const outcomes = useRef(new Map<string, WidgetOutcome>())

  return (
    <ReportCanvas
      report={report}
      onChange={setReport}
      runQuery={client.runQuery}
      onResolved={(o) => (outcomes.current = o)}
    />
  )
}
```

Users can already add and edit widgets by hand at this point. To render a saved,
read-only report instead, use `ReportView` with a `ReportDoc` from
`POST /reports/{id}/run`; see [Widgets](./widgets.md).

## 4. Add the agent

The agent's tools run in the browser against the open report. `buildReportTools`
returns them: `get_report`, `create_report`, `add_report_widget`,
`edit_report_widget` and the rest, plus `explore_data` when it has a way to run
queries. Every build and edit runs what it placed and tells the agent which widgets
came back empty or failed, so it fixes them before it answers.

`useReportModel` fetches the catalog and gives you two things for the agent: `ctx`
(the model and a query runner, for the tools) and `digest` (a text description of
the cubes, to send as context).

```tsx
import { useMemo } from 'react'
import { buildReportTools, useReportModel, type ReportHost } from '@spyglassjs/ui'

const model = useReportModel(client, {
  scopeNote: 'Data is already limited to the signed-in workspace.',
})

const host = useMemo<ReportHost>(
  () => ({
    getReport: () => reportRef.current,       // keep a ref in sync with `report`
    setReport: (next) => setReport(next),
    getOutcomes: () => outcomes.current,      // what each widget did last time it ran
  }),
  [],
)

const tools = useMemo(() => buildReportTools(host, model.ctx), [host, model.ctx])
```

The tools match the function-tool shape of [Distri](https://github.com/distrihub/distri)'s
React SDK, which is what the demo uses. Pass them as external tools, and send the
digest with each message:

```tsx
import { Chat, DistriProvider, useAgent } from '@distri/react'

function Analyst({ tools, digest }) {
  const { agent } = useAgent({ agentIdOrDef: 'spyglass_analyst' })
  if (!agent || !digest) return null
  return (
    <Chat
      agent={agent}
      threadId="reports"
      externalTools={tools}
      getMetadata={async () => ({ dynamic_sections: [{ key: 'dataset', content: digest }] })}
    />
  )
}
```

The agent definition the demo pushes to Distri is
[`demo/agents/spyglass_analyst.md`](https://github.com/spyglass-dev/spyglass/blob/main/demo/agents/spyglass_analyst.md):
its instructions, and the list of browser tools it may call. Start from it. The
[`reporting`](https://github.com/spyglass-dev/spyglass/blob/main/skills/reporting.md)
skill covers the same ground for other agents.

Using a different agent framework? The tools are plain objects with a name, a JSON
schema for their parameters and a handler; adapt them to whatever your framework
expects.

## What the user gets

- A question in plain words becomes widgets on the page, built from your measures,
  so "revenue" matches your dashboards.
- Every query is compiled with the tenant scope from the session. A member the model
  does not declare never reaches SQL.
- The result is a report they can filter, drill into, edit by hand, keep editing by
  chat, and save.

## Limits today

- The crate is not on crates.io yet; depend on it from git.
- All measures in one query come from one cube.
- No pre-aggregations.

Questions and bug reports: [GitHub issues](https://github.com/spyglass-dev/spyglass/issues).
