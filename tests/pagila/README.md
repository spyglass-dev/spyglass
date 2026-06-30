# tests/pagila — Spyglass on a public dataset

A fully reproducible, **committed** test harness that runs Spyglass against
[**Pagila**](https://github.com/devrimgunduz/pagila) — the canonical Postgres
sample database (a DVD-rental store). No private credentials, no hardcoded host
DB: a script downloads Pagila and loads it into a Docker container.

Pagila is single-tenant, but it has **two stores** — so the cubes use `store_id`
as the tenant dimension to demonstrate Spyglass's mandatory scope isolation.

## Layout

```
tests/pagila/
  docker-compose.yml      # postgres:16 on port 5438
  setup.sh                # download + load Pagila (idempotent)
  teardown.sh             # docker compose down -v
  cubes/pagila.yml        # Payment, Rental, Customer, Film cubes
  reports/                # committed sample reports (run without distri)
  distri/                 # cube-gen + reporter agents (cloud loop, local tools)
  serve.sh  validate.sh   # serve the cubes / smoke-test them
  analyze-with-distri.sh  # full pipeline: dataset → distri cubes → distri reports
  .env.sample             # DATABASE_URL + (optional) DISTRI_* keys
```

## Quick start (no distri needed)

```bash
tests/pagila/setup.sh                 # downloads + loads Pagila into Docker (~10s)
tests/pagila/serve.sh                 # serve cubes at http://127.0.0.1:8089  (Ctrl-C to stop)
tests/pagila/validate.sh              # in another shell: smoke test + scope isolation
```

`validate.sh` asserts each cube answers a query and that store 1 vs store 2
return different revenue (proving `where store_id = $1` is injected).

Open <http://127.0.0.1:8089> for the embedded explorer (cubes + query runner +
the committed sample reports under `reports/`).

## Rust integration test

A DB-gated test exercises the real runtime path. It skips unless the DB is up:

```bash
tests/pagila/setup.sh
PAGILA_DATABASE_URL=postgres://postgres:postgres@localhost:5438/pagila \
  cargo test --test pagila_integration -- --nocapture
```

The rest of `cargo test` is pure (no DB) and always runs.

## Full distri pipeline (optional)

With `DISTRI_API_KEY` / `DISTRI_WORKSPACE_ID` in `tests/pagila/.env`, drive the
whole flow with distri — cloud reasoning, **local** tools (it profiles the local
DB and writes files here):

```bash
cp tests/pagila/.env.sample tests/pagila/.env   # fill in DISTRI_* keys
tests/pagila/analyze-with-distri.sh
```

It sets up the dataset, has a distri agent author cubes from the live schema,
serves them, and has another agent build reports — then prints the report list.

## Cleanup

```bash
tests/pagila/teardown.sh    # removes the container + data volume
```
