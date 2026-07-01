# Spyglass Development Guidelines

Spyglass is a **domain-agnostic** semantic layer: a Cube-style model, a SQL
compiler, and a single query endpoint (Postgres by default). It is designed to
be lifted out of this repo and open-sourced as-is.

## ⚠️ Keep the committed tree domain-agnostic

Nothing host-, product-, or tenant-specific goes in the committed code, skills,
examples, or docs. No real databases, credentials, or product schemas. If it
names a real DB, real cubes, or a specific product, it belongs in `testing/`.

## Local development & testing — use the `testing/` folder

**`testing/` is where you develop and test.** It is **gitignored in its
entirety** and holds everything local and secret: `testing/.env`
(`DATABASE_URL` + server config), `testing/cubes/` (real cube definitions),
`testing/logs/`, offline dumps, helper scripts, and `testing/README.md` (the
host-specific notes — which DB, which cubes, how they were generated).

The `spyglass-server` binary **auto-loads `testing/.env` via dotenvy** when run
with the docker-style working-dir flag — no manual `source` needed:

```bash
spyglass-server -C testing serve      # cwd → testing/, reads testing/.env, loads testing/cubes
spyglass-server -C testing validate   # load cubes, no DB
curl -s localhost:8088/health
```

Real process env vars override the `.env` file. Full setup/runbook:
**`skills/local-development.md`**. The host-specific details for the current
local setup live in `testing/README.md` (gitignored).

> Watch out for shell cwd drift: relative paths like `./cubes` resolve against
> the current directory. Run the binary from the repo root with `-C testing`,
> or use the `testing/*.sh` helpers, rather than `cd`-ing around.

## Project structure

```
spyglass/
  Cargo.toml          # the engine crate (lib + spyglass-server bin)
  src/                # model, query, compiler, context, loader, engine/*, analyze
  src/bin/spyglass-server.rs   # serve | schema | analyze | bundle | validate
  tests/              # cargo tests (pure compiler — no DB)
  examples/           # generic, domain-agnostic cube definitions
  skills/             # distri agent skills + local-development runbook
  ui/                 # @spyglass/ui — embeddable JSON-expressible widgets (React) + Storybook
  studio/             # @spyglass/studio — standalone query/editor app (Vite)
  web/                # Docusaurus docs site (docs in web/docs)
  testing/            # LOCAL dev + test harness — gitignored (see above)
  package.json        # pnpm workspace root (ui + studio + web)
```

## Commands

```bash
# Rust engine
cargo build --bin spyglass-server
cargo test
cargo clippy

# JS workspace (widgets + app)
pnpm install
pnpm dev          # studio app (Vite) — consumes @spyglass/ui from source, live HMR
pnpm storybook    # develop @spyglass/ui widgets in isolation (Storybook, HMR)
pnpm test         # @spyglass/ui widget tests
pnpm build        # build ui (lib) → studio → web

# Run the server against your local DB
spyglass-server -C testing serve
```

## JS packages

- **`@spyglass/ui`** (`ui/`) — the widget library: JSON-expressible widgets
  (metric/table/chart/note) + a custom-component registry, as embeddable React
  components. Built to `dist/`, but exposes a `development` export condition
  (`./src/index.ts`) so the studio app and Vite consume its **source** in dev
  (live HMR, no build step). Develop widgets in isolation with `pnpm storybook`.
- **`@spyglass/studio`** (`studio/`) — the standalone Vite app: edit a report's
  JSON, render it live, persist to IndexedDB, import/export. Depends on
  `@spyglass/ui`. `pnpm dev` runs this.

## Skills

- `skills/local-development.md` — set up + run Spyglass locally (this is the
  one for "how do I run it against a DB").
- `skills/schema-to-cubes.md` — turn a DB schema into cube definitions (offline).
- `skills/reporting.md` — author/render reports from query results.
- `skills/row-level-security.md` — the two-layer tenant isolation model
  (fail-closed compiler scope + optional Postgres RLS via a readonly role).
