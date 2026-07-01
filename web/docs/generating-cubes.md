---
id: generating-cubes
title: Generating cubes with distri
sidebar_position: 4
---

# Generating cubes with distri

Writing cubes by hand is fine for a few tables, but the good cubes come from
**reading the database** — its structure *and* its data — alongside the host's
own source code. Spyglass exposes that as an **offline, admin-time** task driven
by [**distri**](https://github.com/distri-ai/distri), an A2A agent platform with
a CLI.

:::info Offline, not a runtime path
`schema`, `analyze`, and `bundle` are **build-time** subcommands. They connect
to `DATABASE_URL` and issue many read-only queries. They are safe to run
repeatedly in an admin setup and are **not** part of the tenant-scoped runtime
path (`serve` / `POST /query`).
:::

## 1. Point it at a database

```bash
cp .env.sample .env
# edit DATABASE_URL=postgres://user:password@localhost:5432/mydb
set -a; source .env; set +a
```

## 2. The offline subcommands

The `spyglass-server` binary connects to `DATABASE_URL` and emits JSON:

```bash
# Structure only — tables and columns from information_schema.
cargo run -p spyglass --bin spyglass-server -- schema > schema.json

# Data PROFILE — row counts, cardinality, ranges, top values, and a
# suggested role (dimension | measure | id | skip) per column.
cargo run -p spyglass --bin spyglass-server -- analyze --profile
cargo run -p spyglass --bin spyglass-server -- analyze --profile --table orders
cargo run -p spyglass --bin spyglass-server -- analyze --profile --filter workspace_id=ws_123

# BUNDLE — schema + profile + the contents of the given source paths, as ONE
# JSON. This is the input a distri agent reads to author cubes: the service /
# query code reveals intent (status columns, score fields, tenant keys) that
# the schema alone doesn't.
cargo run -p spyglass --bin spyglass-server -- bundle --profile \
  --source path/to/schema.rs --source path/to/services
```

Why the profile matters: distinct/top values reveal the real categorical
**dimensions** (e.g. the actual `status` values), numeric columns and ranges
reveal **measures**, `*_id` columns are keys, and `min`/`max` on timestamps show
the usable date range.

## 3. Drive it with distri (inline)

[distri](https://github.com/distri-ai/distri) runs an agent that calls `bundle`,
reads the schema + data + source in one shot, and writes cube YAML — following
the bundled [`schema-to-cubes`](https://github.com/spyglass-dev/spyglass/blob/main/skills/schema-to-cubes.md)
skill. Run it inline from the repo root:

```bash
# One-shot, non-interactive — emit cubes for this database into ./examples
distri run schema-to-cubes \
  "Profile this database and write cube YAML into ./examples. Use
   `spyglass-server bundle --profile --source src` to read the schema, the data
   profile, and the source together, then follow the schema-to-cubes skill."

# …or work interactively
distri tui schema-to-cubes
```

distri reads `DATABASE_URL` from the same environment, so the `.env` you set up
in step 1 is all the agent needs to reach your database. The skills that ship
with this repo (`skills/schema-to-cubes.md`, `skills/reporting.md`) are written
for exactly this loop — push them to your distri workspace with `distri push`
if you keep your own copies.

## 4. Serve the generated cubes

The agent writes YAML into your cube directory (`./examples` above, or wherever
you point `REPORTING_CUBES`). Start the runtime server and query them:

```bash
REPORTING_CUBES=./examples cargo run -p spyglass --bin spyglass-server
```

Now continue with [Querying](./querying.md) and [Widgets & reports](./widgets.md).
