---
id: intro
title: Introduction
sidebar_position: 1
slug: /
---

# Spyglass

**Spyglass** is a small, self-contained, **domain-agnostic** semantic-layer
framework. You define metrics and dimensions in a **Cube-style model**, query
them through a single endpoint, and render the results as JSON widgets.

It is meant to be embedded as a Rust crate *or* run as a standalone binary, and
it is deliberately host-agnostic: it ships no business-specific cubes. You bring
your database, your cube definitions, and your security context.

## Why a semantic layer?

Instead of letting every report write raw SQL against raw tables, you describe
your data once as **cubes** — entities with **measures** (aggregations like
`count`, `revenue`, `avg_order`) and **dimensions** (group-by / filter columns
like `status`, `region`, `created_at`). Callers then ask for measures and
dimensions; Spyglass compiles that into safe, parameterized SQL and runs it.

This gives you:

- **Injection-safe SQL by construction** — the compiler only emits members the
  model declares; callers never hand-write SQL.
- **Scoping you can't escape** — a `SecurityContext` injects mandatory tenant
  filters (e.g. `workspace_id`), so a caller can never widen scope or read raw
  tables.
- **One stable vocabulary** — agents, dashboards, and the UI all reference data
  by `Cube.member`, not by column.

## The two paths

| Path | When | How |
|------|------|-----|
| **Offline / admin** | Build cubes from a real database | `spyglass-server schema / analyze / bundle`, driven by a [distri](./generating-cubes.md) agent |
| **Runtime** | Serve scoped queries | `spyglass-server serve` → `POST /query`, or embed the crate |

## Where to go next

- [Getting started](./getting-started.md) — build it and serve the demo cubes.
- [The cube format](./cube-format.md) — how a model is defined.
- [Generating cubes with distri](./generating-cubes.md) — point it at a DB and
  let an agent author cubes.
- [Querying](./querying.md) — the query shape and the `POST /query` endpoint.
- [Widgets & reports](./widgets.md) — turning results into renderable docs.
- [Architecture](./architecture.md) — the nautical map of components.

## License

Spyglass is licensed under the
[Apache License 2.0](https://github.com/distri-ai/spyglass/blob/main/LICENSE.md).
