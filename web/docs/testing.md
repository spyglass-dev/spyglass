---
id: testing
title: Testing
sidebar_position: 9
---

# Testing

Spyglass is split so that **most tests need no database**. The compiler, loader,
report resolver, and metadata are pure functions; only end-to-end execution
needs Postgres, and that's gated behind an env var.

## Pure tests (no DB)

```bash
cargo test -p spyglass
```

These lock the behavior that matters and run in milliseconds:

- **compiler** — the generated SQL + bound params, mandatory scope injection,
  per-cube scoping, and the placeholder **type casts** (`$n::numeric` /
  `::timestamptz` / `::boolean`) that let non-text tenant/filter columns work.
- **loader** — the `cubes:` map form, the canonical Cube **list form**, and
  `name` backfill from the map key.
- **report** — how a `QueryResult` resolves into data-bearing widgets.
- **meta** — the catalog projection, and that **SQL never leaks** into `/meta`.

## Validating cubes (no DB)

`validate` loads a cube directory and reports what's in it — for CI or an agent
self-checking generated cubes. It fails (non-zero) on a parse error and warns on
a cube with no tenant dimension:

```bash
spyglass-server -C tests/pagila validate
# OK: 4 cube(s) in ./cubes
#   Payment: 3 measure(s), 3 dimension(s), tenant=store_id
#   …
```

## Integration test (with a database)

The [Pagila](./getting-started.md#see-it-in-action--the-pagila-demo) harness
gives you a real database to test against. The Rust integration test skips
unless `PAGILA_DATABASE_URL` is set, so default `cargo test` stays DB-free:

```bash
tests/pagila/setup.sh
PAGILA_DATABASE_URL=postgres://postgres:postgres@localhost:5438/pagila \
  cargo test --test pagila_integration -- --nocapture
```

It loads the committed cubes, runs a scoped query, and asserts the `store_id`
scope isolates the two stores.

There's also a shell smoke test that hits a **running** server (a query per cube
+ a scope-isolation assertion):

```bash
tests/pagila/serve.sh      # in one shell
tests/pagila/validate.sh   # in another
```

## Testing your own cubes

The same pattern works for any database:

1. Author cubes (or [generate them with distri](./generating-cubes.md)).
2. `spyglass-server -C <dir> validate` — they parse and have tenant keys.
3. Point a gated integration test (or `validate.sh`) at your DB and assert a few
   known totals + that two tenants differ.

For unit-testing query construction without any DB, call the pure compiler
directly:

```rust
let c = spyglass::compile(&model, &query, &ctx)?;   // c.sql, c.params
assert!(c.sql.contains("where workspace_id = $1"));
```
