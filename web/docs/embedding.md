---
id: embedding
title: Embedding in other apps
sidebar_position: 8
---

# Embedding in other apps

Spyglass is built to be embedded, not just run standalone. There are three
layers you can pull into a host app — the **engine** (Rust), the **HTTP API**
(any frontend), and the **widgets** (React) — and you can mix them.

## 1. The engine, in-process (Rust)

`spyglass` is a normal crate. The host owns the DB client and builds the
`SecurityContext` server-side, so the tenant value never comes from the caller.

```toml
[dependencies]
# Bring-your-own DB client — opt out of the bundled rustls server stack.
spyglass = { version = "0.1", default-features = false, features = ["postgres"] }
```

```rust
use spyglass::{PostgresEngine, SecurityContext};
use spyglass::query::ScalarValue;
use std::collections::BTreeMap;

let model = spyglass::loader::load_dir("./cubes")?;        // or build Model directly
let engine = PostgresEngine::connect(&database_url).await?;

// The host pins the scope from the authenticated session — not the request.
let mut scope = BTreeMap::new();
scope.insert("Orders.workspace_id".into(), ScalarValue::String(session.workspace_id));
let ctx = SecurityContext { scope };

let result = engine.run(&model, &query, &ctx).await?;       // QueryResult { columns, rows, sql }
```

Discover what's queryable with `model.metadata()` (the same payload `/meta`
returns) and resolve saved reports with `spyglass::report::resolve_widget`.

The compiler is **pure** — `spyglass::compile(&model, &query, &ctx)` returns the
parameterized SQL with no DB, so you can unit-test query construction (see
[Testing](./testing.md)).

## 2. The HTTP API (any frontend)

Run `spyglass-server` and call it from any stack. The surface is small (full
list under [Querying → Server endpoints](./querying.md#server-endpoints)):
`GET /meta`, `POST /query`, `POST /analyze`, and the report endpoints.

Spyglass sends a permissive read-CORS header, but for a separate dev server the
clean pattern is a **proxy** (no CORS at all) — e.g. Vite:

```ts
// vite.config.ts
server: {
  proxy: { '/api': { target: 'http://127.0.0.1:8088', changeOrigin: true,
                     rewrite: (p) => p.replace(/^\/api/, '') } },
}
```

Then the host calls `/api/meta`, `/api/query`, etc. In production, serve your
app from the same origin as spyglass-server (it can embed your built UI — see
below) and drop the `/api` prefix.

## 3. The widgets (React)

`@spyglass/ui` renders a `ReportDoc` (or a single `WidgetSpec`) with the standard
widgets — `metric`, `table`, `chart`, `note` — and a **custom-component
registry**. It's presentational and dependency-light, so it drops into any React
app:

```tsx
import { ReportView, type ReportDoc, type WidgetRegistry } from '@spyglass/ui'

const doc: ReportDoc = await fetch('/api/reports/sales/run', { method: 'POST', body: '{}' }).then(r => r.json())

<ReportView doc={doc} registry={{}} />
```

### Custom components (your own data formats)

The `custom` widget type lets a host plug in widgets that **define their own
data format**. Register them by name; `ReportView` resolves
`{ type: 'custom', component }` against the registry:

```tsx
import type { WidgetRegistry, CustomWidgetProps } from '@spyglass/ui'

function Leaderboard({ spec }: CustomWidgetProps) {
  // spec.data / spec.props are whatever your component declares it needs
  return <ol>{(spec.data as string[]).map((name) => <li key={name}>{name}</li>)}</ol>
}

const registry: WidgetRegistry = { leaderboard: Leaderboard }

// A report can now include: { "type": "custom", "component": "leaderboard", "data": ["…"] }
<ReportView doc={doc} registry={registry} />
```

This is how a host (e.g. an app embedding Spyglass) adds domain-specific widgets
on top of the framework's generic ones without forking the renderer.

## 4. The whole Studio app, embedded in the binary

To ship one self-contained binary that serves both the APIs and a UI, build the
[Studio](./widgets.md#studio) app and compile it in with the `ui` feature:

```bash
make ui                                  # pnpm build studio + cargo build --release --features ui
./target/release/spyglass-server serve   # `/` serves Studio, same-origin APIs
```
