---
id: architecture
title: Architecture
sidebar_position: 7
---

# Architecture

Spyglass is organized as a small ecosystem with a nautical theme. Today most of
it lives in one Rust crate plus the UI packages; the names mark the seams along
which it can grow.

## The nautical map

| Component | Role | Today |
|-----------|------|-------|
| **spyglass** | semantic layer | the crate (`model` / `query` / `context`) |
| **sextant** | SQL generator | `compiler` |
| **compass** | metadata / catalog | `introspect` (+ `loader`) |
| **telescope** | query planner | folded into `compiler` for now |
| **harbor** | cache | planned |
| **captain** | orchestration | `engine` (+ the host) |

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
  web/                # Docusaurus docs site (docs live in web/docs)
```

## Design principles

- **Domain-agnostic** — no host-specific cubes, skills, or schema live in the
  crate. The host supplies the model, a DB client, and the security context.
- **Pluggable engines** — behind feature flags; `postgres` is the default. The
  pure `compiler` turns a Cube-shaped query + model + security context into
  parameterized SQL; engines execute it.
- **Scoped by construction** — the `SecurityContext` injects mandatory tenant
  filters; callers pick measures/dimensions and can never escape scope or read
  raw tables.
- **Embeddable** — `spyglass` is a normal crate, or run the standalone
  `spyglass-server` binary. TLS is on by default (rustls) so it connects to real
  databases; bring-your-own-client embedders opt out via
  `default-features = false, features = ["postgres"]`.

## Runtime vs. offline

- **Runtime** (`serve`): the only tenant-scoped path. `POST /query` →
  compile → scope → execute.
- **Offline / admin** (`schema` / `analyze` / `bundle`): build-time data
  inspection for [authoring cubes](./generating-cubes.md). Many read-only
  queries, no tenant scoping, never on the runtime path.
