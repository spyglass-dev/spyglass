# Spyglass 🔭

A small, self-contained, **domain-agnostic** semantic-layer framework. Define
metrics and dimensions in a **Cube-style** model, query them through one
endpoint, and render the results as JSON widgets — embeddable as a Rust crate or
runnable as a standalone binary.

> **Open source under [Apache-2.0](./LICENSE.md).**

📖 **Full documentation:** the [`web/docs/`](./web/docs) folder, published as a
Docusaurus site — see [Documentation site](#documentation-site).

## What it is

Instead of letting every report write raw SQL against raw tables, you describe
your data once as **cubes** — entities with **measures** (aggregations) and
**dimensions** (group-by / filter columns). Callers ask for measures and
dimensions; Spyglass compiles that into safe, parameterized SQL, injects a
mandatory tenant scope, and runs it. Agents, dashboards, and the UI all
reference data by `Cube.member`.

- **Injection-safe by construction** — the compiler only emits members the model
  declares; callers never hand-write SQL.
- **Scoped by construction** — a `SecurityContext` injects mandatory tenant
  filters; a caller can never widen scope or read raw tables.
- **Embeddable** — a normal crate, or run the `spyglass-server` binary.

## Try it: ask your data, in the browser

[`demo/`](./demo) is a report canvas with a distri analyst beside it, over a
store dataset generated inside the browser tab. Ask "which channels convert
best?", the analyst builds the report, click a bar to drill, ask a follow-up
about the slice you drilled into, save it, export it.

There is no server. The spyglass compiler runs as WebAssembly
([`wasm/`](./wasm)) and DuckDB-WASM executes the SQL it produces, so the demo
runs the same query plan and result assembly as the Postgres engine.

```bash
pnpm install
pnpm --filter @spyglass/demo wasm   # wasm-pack + the wasm32-unknown-unknown target
pnpm --filter @spyglass/demo dev    # http://127.0.0.1:5198 (add ?smoke for the engine self-test)
```

The analyst needs a distri workspace (`demo/.env.example`); the report,
drilling, filters and exports work without one. How a question becomes a
report: [`demo/HOW-IT-WORKS.md`](./demo/HOW-IT-WORKS.md).

## The cube format

Spyglass models use a **Cube-style** YAML format. The term *cube* comes from
[**Cube**](https://cube.dev), the open-source semantic layer
([cube-js/cube](https://github.com/cube-js/cube)); Spyglass adopts its core
vocabulary — *cubes*, *measures*, *dimensions* — in a small, embeddable subset.
It is **not** Cube and implements only what's documented in
[web/docs/cube-format.md](./web/docs/cube-format.md).

```yaml
cubes:
  Orders:
    sql_table: orders
    dimensions:
      tenant_id:  { type: string, sql: tenant_id, tenant: true } # mandatory scope
      status:     { type: string, sql: status }
      created_at: { type: time,   sql: created_at }
    measures:
      count:   { type: count }
      revenue: { type: sum, sql: amount_cents, title: Revenue }
```

A full demo lives in [`examples/`](./examples).

## Installing

Install the `spyglass-server` binary with cargo:

```bash
cargo install spyglass                       # from crates.io
cargo install --git https://github.com/spyglass-dev/spyglass spyglass   # from git

# from a local checkout (run in the repo root):
cargo install --bin spyglass-server --path . --force --locked --debug
```

This puts `spyglass-server` on your `PATH`. Bring-your-own-DB-client embedders
who only want the library add the crate as a dependency instead:

```toml
[dependencies]
spyglass = { version = "0.1", default-features = false, features = ["postgres"] }
```

## Quick start

With the binary installed (or run it from a checkout with `cargo run -p spyglass
--bin spyglass-server -- …`):

```bash
cp .env.sample .env                # set DATABASE_URL
set -a; source .env; set +a        # the binary reads the environment

REPORTING_CUBES=./examples spyglass-server      # serve POST /query  (Postgres client over TLS)
```

From a source checkout instead:

```bash
cargo test -p spyglass             # pure compiler tests, no DB
REPORTING_CUBES=./examples \
  cargo run -p spyglass --bin spyglass-server   # serve POST /query  (Postgres client over TLS)
```

```bash
curl -s localhost:8088/query -H 'content-type: application/json' -d '{
  "query": { "measures": ["Orders.revenue"], "dimensions": ["Orders.status"] },
  "scope": { "Orders.tenant_id": "ws_123" }
}'
```

See [web/docs/getting-started.md](./web/docs/getting-started.md) and
[web/docs/querying.md](./web/docs/querying.md).

### Try it on a real dataset

The repo ships a one-command, reproducible harness on the public
[Pagila](https://github.com/devrimgunduz/pagila) dataset (a DVD-rental store) in
Docker — it uses the two stores as tenants to demonstrate scope isolation:

```bash
tests/pagila/setup.sh      # download + load Pagila into Docker
tests/pagila/serve.sh      # serve cubes at http://127.0.0.1:8089 (explorer UI)
tests/pagila/validate.sh   # smoke test + scope-isolation check
```

A DB-gated integration test (`cargo test --test pagila_integration`) runs the
real query path against it; the rest of `cargo test` is pure. See
[`tests/pagila/`](./tests/pagila).

## Generating cubes from your database with distri

The best cubes come from reading the database — structure **and** data — next to
the host's source. Spyglass exposes that as an **offline, admin-time** task
driven by [**distri**](https://github.com/distri-ai/distri), an A2A agent
platform with a CLI.

```bash
cp .env.sample .env                # set DATABASE_URL — distri reads the same env
set -a; source .env; set +a

# Offline subcommands emit JSON for an agent to read:
cargo run -p spyglass --bin spyglass-server -- schema            # tables + columns
cargo run -p spyglass --bin spyglass-server -- analyze --profile # cardinality, ranges, top values
cargo run -p spyglass --bin spyglass-server -- bundle  --profile --source src  # schema + profile + source, one JSON

# Drive it inline: distri reads the bundle and writes cube YAML into ./examples,
# following the bundled schema-to-cubes skill.
distri run schema-to-cubes \
  "Profile this database with `spyglass-server bundle --profile --source src` and
   write cube YAML into ./examples, following the schema-to-cubes skill."
```

`schema` / `analyze` / `bundle` are **offline** — not the tenant-scoped runtime
path. Full walkthrough: [web/docs/generating-cubes.md](./web/docs/generating-cubes.md).
The agent skills ship in [`skills/`](./skills).

## Widgets & reports

`@spyglassjs/ui` renders query results as **reports** — saveable, exportable docs
of JSON widgets (`metric`, `table`, `chart`, `pivot`, `note`, `custom`, `view`),
as embeddable React components. `@spyglass/studio` is the standalone editor that
consumes them. See [web/docs/widgets.md](./web/docs/widgets.md).

```bash
pnpm add @spyglassjs/ui
```

- Titles, formats and descriptions come from the model (`memberIndex(meta)`).
- Charts drill on click and cross-filter the rest of the report, draw the
  previous period as a dashed line, take a second axis (`y2`) and a `target`,
  and mark an unfinished last period instead of drawing it as a drop.
- Metrics carry a sparkline and the change as % (amounts) or points (rates).
- Every widget sits in a `WidgetCard` with an export menu. Exporters are a
  registry (`WidgetExporter`, `ReportExporter`): CSV of the full result, PNG,
  JSON and Markdown are built in, and a host adds its own.
- `buildReportTools` gives a distri agent the tools to build and edit the open
  report from the browser.

The JS packages (`ui`, `studio`, `web`) form a **pnpm workspace** rooted at the
repo. Install once at the root, then use the workspace scripts. `pnpm dev` runs
the studio app and consumes `@spyglassjs/ui` straight from source (live HMR, no
build step); `pnpm storybook` develops the widgets in isolation:

```bash
pnpm install            # install all workspace packages
pnpm dev                # run the studio app (Vite) — picks up @spyglassjs/ui edits live
pnpm storybook          # develop @spyglassjs/ui widgets in Storybook (HMR) at localhost:6006
pnpm dev:docs           # run the docs site (Docusaurus) at localhost:3000
pnpm build              # build every package (ui, studio, web)
pnpm test               # @spyglassjs/ui tests
```

## Layout

```
spyglass/
  Cargo.toml          # the engine crate (lib + spyglass-server bin)
  src/                # model, query, compiler, context, loader, engine/*
  tests/              # cargo tests (pure compiler — no DB)
  examples/           # generic, domain-agnostic cube definitions
  skills/             # distri agent skills (querying + authoring reports)
  ui/                 # @spyglassjs/ui — embeddable JSON-expressible widgets (React) + Storybook
  studio/             # @spyglass/studio — standalone query/editor app
  wasm/               # spyglass-wasm — the compiler for the browser (plan + assemble)
  demo/               # @spyglass/demo — ask-your-data demo (WASM + DuckDB + distri)
  web/                # Docusaurus docs site (docs in web/docs)
  docs/specs/         # design notes
  package.json        # pnpm workspace root (dev / build scripts)
  pnpm-workspace.yaml # ui + studio + demo + web
  .env.sample         # DATABASE_URL + server config
```

See [web/docs/architecture.md](./web/docs/architecture.md) for the component map.

## Documentation site

The documentation lives in [`web/docs/`](./web/docs) as Markdown (readable here
on GitHub) and is published as a Docusaurus site from [`web/`](./web). The
[`.github/workflows/docs.yml`](./.github/workflows/docs.yml) workflow builds and
deploys it to GitHub Pages on every push to `main`.

```bash
pnpm install && pnpm dev:docs   # local docs at http://localhost:3000
```

## License

[Apache License 2.0](./LICENSE.md).
