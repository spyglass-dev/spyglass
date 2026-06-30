# Spyglass

A small, self-contained, **domain-agnostic** semantic-layer framework, designed
to be lifted out of this repo and open-sourced. Define metrics/measures in a
Cube-style model, query them through one endpoint, and render the results as
JSON widgets.

## The ecosystem (nautical map)

| Component   | Role               | Today                              |
|-------------|--------------------|------------------------------------|
| **spyglass**  | semantic layer     | the crate (`model` / `query` / `context`) |
| **sextant**   | SQL generator      | `compiler`                         |
| **compass**   | metadata / catalog | `introspect` (+ `loader`)          |
| **telescope** | query planner      | folded into `compiler` for now     |
| **harbor**    | cache              | planned                            |
| **captain**   | orchestration      | `engine` (+ the host)              |

## Layout

```
spyglass/
  Cargo.toml          # the engine crate (lib + spyglass-server bin)
  src/                # model, query, compiler, context, loader, engine/*
  tests/              # cargo tests (pure compiler — no DB)
  cubes/              # Cube-format metric definitions (generic example.yml)
  skills/             # distri agent skills (querying + authoring reports)
  ui/                 # @spyglass/ui — JSON-expressible widgets (React)
  studio/             # @spyglass/studio — standalone query/editor app
```

This crate is **domain-agnostic** and designed to be extracted to its own repo:
no host-specific cubes, skills, or schema live here. The host (e.g. an app that
embeds it) supplies its own cube definitions, security context, and DB client.

## Engine (Rust crate)

- **Pluggable** behind feature flags; `postgres` is the default. The pure
  `compiler` turns a Cube-shaped `Query` + `Model` + `SecurityContext` into
  parameterized SQL (injection-safe); engines execute it.
- **Scoped by construction** — the `SecurityContext` injects mandatory
  tenant filters (workspace/student); callers pick measures/dimensions and can
  never escape scope or see raw tables.
- **Embeddable** — `spyglass` is a normal crate; the host supplies the model,
  a DB client, and the security context. Or run the standalone
  `spyglass-server` binary (`POST /query`, reads cube defs from `./cubes`).
- **TLS by default** (`tls` feature, rustls) so it connects to real databases;
  embedders that bring their own client opt out with
  `default-features = false, features = ["postgres"]`.

```bash
cargo test -p spyglass                                          # compiler tests
cargo run -p spyglass --bin spyglass-server                    # serve POST /query (TLS)
cargo run -p spyglass --bin spyglass-server -- schema          # offline: dump schema
cargo run -p spyglass --bin spyglass-server -- analyze --profile
cargo run -p spyglass --bin spyglass-server -- bundle --profile --source <path-to-schema> --source <path-to-services>
```

Building cubes is an OFFLINE/admin task (not a runtime path): a distri-CLI
agent runs `bundle` to read the schema + data profile + relevant source code in
one shot, then writes cube YAML into `cubes/` (see `skills/schema-to-cubes.md`).

## Widgets (the UI package)

JSON-expressible widgets — `metric`, `table`, `chart`, `note`, and `custom`
(host-registered). A `ReportDoc` is an ordered list laid out on a 4-col grid.
Dependency-light + inline-styled so it renders in the studio and embeds in any
host app alike.

```bash
pnpm --filter @spyglass/ui build
pnpm --filter @spyglass/ui test
```

> Note: the npm packages use the `@spyglass/*` scope; the Rust crate is `spyglass`.

## Studio

A standalone Vite app: edit a report's JSON, see it render live, persist to
IndexedDB, import/export. (Agent editor + live query panel are in progress.)

## Status

- [x] Engine: Cube model, query compiler, Postgres engine (TLS), loader, tests
- [x] `spyglass-server` binary: `serve` (POST /query) + offline `schema` /
      `analyze` / `bundle`
- [x] UI widgets (metric/table/chart/note/custom) + tests
- [x] Studio shell (JSON editor + live render + IDB + import/export)
- [ ] Studio agent editor + live query panel
- [ ] Vega-Lite chart renderer behind the `chart` spec
