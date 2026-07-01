# Row-level security (defense in depth)

Spyglass isolates tenants in **two independent layers**. Either alone keeps a
query inside one workspace; together they mean a bug in one can't leak data.

## Layer 1 — the compiler fails closed (always on)

Every cube marks its tenant column with `tenant: true`. The compiler **refuses**
to compile a query against a tenant cube unless the [`SecurityContext`] supplies
a scope value for it — a missing scope is a `MissingTenantScope` error, never an
unscoped full-table read. The host builds the scope from the authenticated
request; the caller/agent picks measures and dimensions but cannot remove or
widen it.

Only trusted admin/offline paths that deliberately read across tenants opt out,
explicitly, via `SecurityContext::allow_unscoped()`.

This layer needs no database setup and is the primary guarantee.

## Layer 2 — Postgres RLS (opt-in)

A second, database-enforced layer for defense in depth: run Spyglass against a
**readonly role** subject to row-level-security policies keyed off a per-request
GUC. Even a query that somehow escaped Layer 1 physically cannot return another
tenant's rows.

### 1. A readonly role

```sql
create role spyglass_ro nologin;
grant connect on database app to spyglass_ro;
grant usage on schema public to spyglass_ro;
grant select on all tables in schema public to spyglass_ro;
alter default privileges in schema public grant select on tables to spyglass_ro;
-- Give this role no insert/update/delete/ddl. Log in through it (or `set role`).
```

### 2. Enable RLS + a policy per tenant table

Policies read a GUC (here `app.workspace_id`) that Spyglass sets per query. Cast
it to match the column type.

```sql
alter table classes enable row level security;
alter table classes force row level security;   -- applies to the table owner too
create policy tenant_isolation on classes
  using (workspace_id = current_setting('app.workspace_id'));

-- number column → cast the setting:
--   using (store_id = current_setting('app.workspace_id')::int)
```

Do this for every tenant table. A shared catalog table with no tenant column
(e.g. Pagila's `film`) keeps RLS off — Spyglass sends no GUC for non-tenant
queries.

### 3. Point Spyglass at it

```bash
DATABASE_URL=postgres://spyglass_ro:…@host/app   # the readonly role
SPYGLASS_RLS_GUC=app.workspace_id                 # enables the RLS path
spyglass-server -C testing serve
```

With `SPYGLASS_RLS_GUC` set, every runtime query runs inside a transaction that
first calls `set_config('app.workspace_id', <scope value>, true)` (both name and
value are bound parameters — never interpolated) and then selects, so the
policies above enforce isolation. The scope value comes from the same trusted
`SecurityContext` scope as Layer 1.

### Notes

- **Which scope value?** The engine uses the request's tenant scope value. When
  a report spans several cubes, the host scopes them all to the same workspace,
  so the value is consistent.
- **Performance.** The current RLS path opens a fresh connection per query. It's
  correct and opt-in; a pooled connection is the natural production follow-up.
- **Embedders.** A host that manages its own client (`PostgresEngine::new`) does
  its own connection setup; set the GUC in your own transaction, or adopt the
  `connect` + `with_rls_guc` path.
