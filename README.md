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

`@spyglass/ui` renders query results as **reports** — saveable, exportable docs
of JSON widgets (`metric`, `table`, `chart`, `note`, `custom`), as embeddable
React components. `@spyglass/studio` is the standalone editor that consumes
them. See [web/docs/widgets.md](./web/docs/widgets.md).

The JS packages (`ui`, `studio`, `web`) form a **pnpm workspace** rooted at the
repo. Install once at the root, then use the workspace scripts. `pnpm dev` runs
the studio app and consumes `@spyglass/ui` straight from source (live HMR, no
build step); `pnpm storybook` develops the widgets in isolation:

```bash
pnpm install            # install all workspace packages
pnpm dev                # run the studio app (Vite) — picks up @spyglass/ui edits live
pnpm storybook          # develop @spyglass/ui widgets in Storybook (HMR) at localhost:6006
pnpm dev:docs           # run the docs site (Docusaurus) at localhost:3000
pnpm build              # build every package (ui, studio, web)
pnpm test               # @spyglass/ui tests
```

## Layout

```
spyglass/
  Cargo.toml          # the engine crate (lib + spyglass-server bin)
  src/                # model, query, compiler, context, loader, engine/*
  tests/              # cargo tests (pure compiler — no DB)
  examples/           # generic, domain-agnostic cube definitions
  skills/             # distri agent skills (querying + authoring reports)
  ui/                 # @spyglass/ui — embeddable JSON-expressible widgets (React) + Storybook
  studio/             # @spyglass/studio — standalone query/editor app
  web/                # Docusaurus docs site (docs in web/docs)
  package.json        # pnpm workspace root (dev / build scripts)
  pnpm-workspace.yaml # ui + studio + web
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
