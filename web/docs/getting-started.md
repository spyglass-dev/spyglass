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
cargo install --git https://github.com/distri-ai/spyglass spyglass   # from git
```

This puts `spyglass-server` on your `PATH`, so the commands below can be run as
`spyglass-server …` directly. To embed the **library** instead of the binary,
add the crate as a dependency (see [Embedding the crate](#embedding-the-crate)).

## 1. Configure your environment

Copy the sample env file and point it at your database:

```bash
cp .env.sample .env
# edit DATABASE_URL=postgres://user:password@localhost:5432/mydb
set -a; source .env; set +a   # the binary reads the environment; it does not auto-load .env
```

| Variable | Required | Default | Used by |
|----------|----------|---------|---------|
| `DATABASE_URL` | ✅ | — | runtime + offline subcommands |
| `REPORTING_CUBES` | | `./cubes` | `serve` (cube directory to load) |
| `REPORTING_LOGS` | | `./logs` | `serve` (query log directory) |
| `REPORTING_ADDR` | | `127.0.0.1:8088` | `serve` (bind address) |

## 2. Run the tests (no DB needed)

The compiler is pure — it turns a query + model + security context into SQL with
no database connection, so its tests run offline:

```bash
cargo test -p spyglass
```

## 3. Serve the demo cubes

The repo ships generic example cubes in [`examples/`](https://github.com/distri-ai/spyglass/tree/main/examples).
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
        "scope": { "tenant_id": "ws_123" }
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
