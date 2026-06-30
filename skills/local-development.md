---
name: local_development
description: "Set up and run Spyglass locally against a real database. All local dev + testing happens in the gitignored testing/ folder: a testing/.env (DATABASE_URL + server config), a testing/cubes/ directory, and helper scripts. The spyglass-server binary auto-loads testing/.env via dotenvy when run with `-C testing`, so you never source env by hand."
tags:
  - development
  - testing
  - setup
---

# Local development

Spyglass is a **domain-agnostic** crate (meant to be lifted out and
open-sourced). So nothing host- or tenant-specific is ever committed. Instead,
**all local development and testing happens in the `testing/` folder**, which is
**gitignored in its entirety**. That is where you point the engine at a real
database, author/generate cubes, serve them, and validate queries.

> Rule of thumb: if it names a real database, real credentials, real cubes, or a
> specific product's schema — it belongs in `testing/`, never in the committed
> tree.

## How env loading works

`spyglass-server` loads a `.env` file via `dotenvy` at startup — **after** the
`-C/--dir` working-directory flag is applied. So:

```bash
spyglass-server -C testing serve     # cwd → testing/, then reads testing/.env
```

reads `testing/.env` automatically (dotenvy also walks up to parent dirs as a
fallback). Real process environment variables always take precedence over the
`.env` file. You do **not** need to `source` anything.

## One-time setup

The `testing/` folder is already gitignored (see `.gitignore`). Create it with:

1. **`testing/.env`** — at minimum a database URL, plus optional server config:

   ```bash
   export DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME

   # optional — resolved relative to the -C testing workdir
   export REPORTING_CUBES=./cubes
   export REPORTING_LOGS=./logs
   export REPORTING_ADDR=127.0.0.1:8088
   ```

2. **`testing/cubes/`** — one or more `*.yml` cube definitions (hand-authored or
   generated; see `skills/schema-to-cubes.md`).

3. Optionally `testing/serve.sh` / `testing/validate.sh` helper scripts that
   `cd` to the repo root and run the binary with `-C testing`.

## Daily commands

All run from the repo root; `-C testing` keeps cubes, logs, and `--source`
paths inside `testing/`:

```bash
spyglass-server -C testing serve      # POST /query + /health against the DB
spyglass-server -C testing validate   # load cubes, no DB — parse self-check
spyglass-server -C testing schema     > testing/schema.json    # offline schema dump
spyglass-server -C testing analyze --profile --table NAME      # offline data profile
```

Health check while serving: `curl -s localhost:8088/health`.

## JS packages (widgets + app)

The reporting widgets and the studio app are a pnpm workspace (`ui/`, `studio/`,
`web/`):

```bash
pnpm install
pnpm dev          # studio app (Vite) — consumes @spyglass/ui from source, live HMR
pnpm storybook    # develop @spyglass/ui widgets in isolation (HMR)
pnpm test         # @spyglass/ui widget tests
```

## What stays in testing/

Host/product-specific notes — which database, which cubes, which tenant key,
how cubes were generated, validation results — live in `testing/README.md`
(gitignored). Keep them there so the committed crate, skills, and docs stay
generic.
