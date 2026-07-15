---
id: getting-started
title: Getting started
sidebar_position: 2
---

# Getting started

## Prerequisites

- **Rust** (stable) for the engine and the `spyglass-server` binary.
- **Postgres** — Spyglass uses Postgres by default (TLS on by default).
- **pnpm + Node** if you want to build the UI widgets or the Studio app.
- **[distri](./generating-cubes.md)** (optional) to generate cubes from a DB.

## Installing

Install the `spyglass-server` binary with cargo:

```bash
cargo install spyglass                       # from crates.io
cargo install --git https://github.com/spyglass-dev/spyglass spyglass   # from git

# from a local checkout (run in the repo root):
cargo install --bin spyglass-server --path . --force --locked --debug
```

The local-checkout form installs the `spyglass-server` binary from the current
source tree — `--force` overwrites a previous install, `--locked` honors
`Cargo.lock`, and `--debug` skips the optimized build for a faster install while
iterating. This puts `spyglass-server` on your `PATH`, so the commands below can
be run as `spyglass-server …` directly. To embed the **library** instead of the binary,
add the crate as a dependency (see [Embedding the crate](#embedding-the-crate)).

## See it in action — the Pagila demo

The fastest way to see Spyglass working end-to-end is the committed
[**Pagila**](https://github.com/devrimgunduz/pagila) harness (the canonical
Postgres sample DB — a DVD-rental store). It downloads the dataset into Docker,
serves cubes, and ships sample reports. Pagila has **two stores**, used as the
tenant (`store_id`) to demonstrate Spyglass's mandatory scope isolation.

```bash
tests/pagila/setup.sh                      # download + load Pagila into Docker (~10s)
make ui DIR=tests/pagila || pnpm --filter @spyglass/studio build  # build the Studio UI
cargo run --features ui --bin spyglass-server -- -C tests/pagila serve
# open http://127.0.0.1:8089
```

(Or skip the UI build and just `cargo run --bin spyglass-server -- -C tests/pagila serve`
— `/` then serves a zero-build explorer with the same views.)

**Browse the cube catalog** (`/meta`) — measures, dimensions, and the `tenant`
key per cube:

![Studio — cube catalog](/img/studio-cubes.png)

**Build a query** point-and-click — pick a cube + measures/dimensions, run it,
see the rows and the compiled SQL:

![Studio — query builder](/img/studio-query.png)

**Run a report** — the sample reports resolve their bound queries live under the
current scope (here, store 1 — change the scope box to compare store 2):

![Studio — reports](/img/studio-reports.png)

Then poke at it from the shell:

```bash
tests/pagila/validate.sh        # smoke-test cubes + assert store 1 ≠ store 2
```

Full walkthrough (including the distri analyze→report pipeline) lives in
[`tests/pagila/README.md`](https://github.com/spyglass-dev/spyglass/tree/main/tests/pagila).

## 1. Configure your environment

Copy the sample env file and point it at your database:

```bash
cp .env.sample .env
# edit DATABASE_URL=postgres://user:password@localhost:5432/mydb
set -a; source .env; set +a   # optional — spyglass-server also auto-loads .env (via dotenvy)
```

| Variable | Required | Default | Used by |
|----------|----------|---------|---------|
| `DATABASE_URL` | ✅ | — | runtime + offline subcommands |
| `REPORTING_CUBES` | | `./cubes` | `serve` (cube directory to load) |
| `REPORTING_REPORTS` | | `./reports` | `serve` (saved-report directory, for `/reports`) |
| `REPORTING_LOGS` | | `./logs` | `serve` (query log directory) |
| `REPORTING_ADDR` | | `127.0.0.1:8088` | `serve` (bind address) |

## 2. Run the tests (no DB needed)

The compiler is pure — it turns a query + model + security context into SQL with
no database connection, so its tests run offline:

```bash
cargo test -p spyglass
```

## 3. Serve the demo cubes

The repo ships generic example cubes in [`examples/`](https://github.com/spyglass-dev/spyglass/tree/main/examples).
Point `REPORTING_CUBES` at it and start the server:

```bash
REPORTING_CUBES=./examples cargo run -p spyglass --bin spyglass-server
# spyglass-server listening on 127.0.0.1:8088
```

Then query it (see [Querying](./querying.md)):

```bash
curl -s localhost:8088/query \
  -H 'content-type: application/json' \
  -d '{
        "query": { "measures": ["Orders.revenue"], "dimensions": ["Orders.status"] },
        "scope": { "Orders.tenant_id": "ws_123" }
      }'
```

## 4. Use your own database

Replace the demo cubes with cubes generated from your schema — see
[Generating cubes with distri](./generating-cubes.md).

## Embedding the crate

Spyglass is a normal Rust crate. The host supplies the `Model`, a DB client, and
the `SecurityContext`. Bring-your-own-client embedders opt out of the bundled
TLS client:

```toml
[dependencies]
spyglass = { version = "0.1", default-features = false, features = ["postgres"] }
```
