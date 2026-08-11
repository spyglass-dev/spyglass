//! Postgres engine — compiles a query and executes it via `tokio-postgres`,
//! mapping rows into JSON keyed by `Cube.member`. Default engine.

use super::{Engine, EngineError};
use crate::context::SecurityContext;
use crate::logging::{now_ms, QueryEvent, QueryExporter};
use crate::model::Model;
use crate::query::{Query, QueryResult, ScalarValue};
use std::sync::Arc;
use std::time::Instant;
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, Row};

pub struct PostgresEngine {
    client: Client,
    /// The connection string `connect` was built from — kept so the RLS path
    /// can open a fresh, transaction-scoped connection per query. `None` for
    /// engines built via [`new`] from a caller-owned client.
    conn_str: Option<String>,
    /// When set, every runtime query runs inside a transaction that first pins
    /// a tenant GUC (`set_config(<guc>, <workspace>, true)`) so Postgres
    /// row-level-security policies can enforce isolation at the database — a
    /// defense-in-depth layer beneath the compiler's mandatory scope filters.
    rls: Option<RlsConfig>,
    exporter: Option<Arc<dyn QueryExporter>>,
    /// When set, an unbounded (or larger) `limit` is clamped to this many
    /// rows, and a result that hits the cap is marked `truncated_at` — so a
    /// UI can tell a truncated table from a complete one.
    max_rows: Option<u32>,
    /// Optional short-TTL result cache. The key includes the compiled SQL,
    /// bound params, and the security scope — a cache that can return one
    /// tenant's rows to another is worse than no cache.
    cache: Option<super::ResultCache>,
}

/// Config for the row-level-security execution path.
#[derive(Clone)]
struct RlsConfig {
    /// Connection string used for the per-query RLS connection (point this at a
    /// **readonly** role for true defense in depth).
    conn_str: String,
    /// The GUC name RLS policies read, e.g. `app.workspace_id`.
    guc: String,
}

impl PostgresEngine {
    /// Wrap an existing client (e.g. one the host already manages). No RLS path
    /// — the embedder owns connection management and applies its own scope.
    pub fn new(client: Client) -> Self {
        Self { client, conn_str: None, rls: None, exporter: None, max_rows: None, cache: None }
    }

    /// Attach a query-log exporter — every executed query is recorded.
    pub fn with_exporter(mut self, exporter: Arc<dyn QueryExporter>) -> Self {
        self.exporter = Some(exporter);
        self
    }

    /// Cap every query at `max` rows. Replaces ad hoc host-side clamps: the
    /// clamp is applied to the compiled limit, and a result that fills the
    /// cap is reported via `QueryResult.truncated_at` instead of silently
    /// looking complete.
    pub fn with_max_rows(mut self, max: u32) -> Self {
        self.max_rows = Some(max);
        self
    }

    /// Cache query results in-process for `ttl`. Keys include SQL, params and
    /// the scope; relative-date queries roll over naturally because the
    /// resolved window lives in the params.
    pub fn with_cache(mut self, ttl: std::time::Duration) -> Self {
        self.cache = Some(super::ResultCache::new(ttl));
        self
    }

    /// Enable the database-level RLS path: each query runs in a transaction
    /// that sets `guc` to the caller's tenant scope value before selecting, so
    /// RLS policies (`using (... = current_setting('<guc>'))`) isolate tenants
    /// at the database even if application-level scoping were bypassed. Only
    /// effective for engines built via [`connect`] (needs the connection
    /// string); a no-op warning otherwise.
    pub fn with_rls_guc(mut self, guc: impl Into<String>) -> Self {
        let guc = guc.into();
        match &self.conn_str {
            Some(conn_str) => self.rls = Some(RlsConfig { conn_str: conn_str.clone(), guc }),
            None => eprintln!("with_rls_guc ignored: engine has no connection string (built via new())"),
        }
        self
    }

    /// Introspect the database's public schema (for auto-building cubes).
    pub async fn introspect(&self) -> Result<crate::introspect::RawSchema, tokio_postgres::Error> {
        crate::introspect::RawSchema::introspect(&self.client).await
    }

    /// Profile the database's data (row counts, cardinality, value ranges,
    /// top values) to inform cube design. Read-only.
    pub async fn analyze(
        &self,
        opts: &crate::analyze::AnalyzeOptions,
    ) -> Result<crate::analyze::DbProfile, tokio_postgres::Error> {
        crate::analyze::analyze(&self.client, opts).await
    }

    /// Connect with a libpq-style connection string. Spawns the connection
    /// driver task. Uses rustls TLS when the `tls` feature is on (default), so
    /// it works against real (TLS-required) databases; falls back to `NoTls`
    /// otherwise. The process-wide rustls crypto provider must be installed by
    /// the caller (the binary does this in `main`).
    #[cfg(feature = "postgres")]
    pub async fn connect(conn_str: &str) -> Result<Self, tokio_postgres::Error> {
        let client = Self::connect_raw(conn_str).await?;
        Ok(Self {
            client,
            conn_str: Some(conn_str.to_string()),
            rls: None,
            exporter: None,
            max_rows: None,
            cache: None,
        })
    }

    /// Open one client + spawn its connection driver. Shared by [`connect`] and
    /// the per-query RLS path.
    #[cfg(feature = "postgres")]
    async fn connect_raw(conn_str: &str) -> Result<Client, tokio_postgres::Error> {
        #[cfg(feature = "tls")]
        let (client, connection) = {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let tls = tokio_postgres_rustls::MakeRustlsConnect::new(config);
            tokio_postgres::connect(conn_str, tls).await?
        };
        #[cfg(not(feature = "tls"))]
        let (client, connection) = tokio_postgres::connect(conn_str, tokio_postgres::NoTls).await?;

        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
            }
        });
        Ok(client)
    }

    /// Compile + execute, returning JSON rows.
    pub async fn run(
        &self,
        model: &Model,
        query: &Query,
        ctx: &SecurityContext,
    ) -> Result<QueryResult, EngineError> {
        let started = Instant::now();

        // Row cap: clamp an unbounded (or larger) limit BEFORE compiling so
        // the cap happens in SQL, and remember that we did — a result that
        // then fills the cap is reported as truncated, never silently
        // complete-looking.
        let (effective, clamped): (std::borrow::Cow<Query>, bool) = match self.max_rows {
            Some(max) if query.limit.is_none_or(|l| l > max) => {
                let mut q = query.clone();
                q.limit = Some(max);
                (std::borrow::Cow::Owned(q), true)
            }
            _ => (std::borrow::Cow::Borrowed(query), false),
        };
        let query: &Query = effective.as_ref();
        // One clock per run: the current window and any comparison window
        // resolve against the SAME instant.
        let now = chrono::Utc::now();
        let compiled = crate::compiler::compile_at(model, query, ctx, now)?;

        // Comparison window, compiled UP FRONT so the cache key covers it —
        // a compare and a non-compare query share the current-window SQL and
        // must never collide in the cache. Execution happens after the main
        // fetch (and only on a cache miss).
        let prev: Option<(usize, crate::compiler::Compiled)> = match query
            .time_dimensions
            .iter()
            .enumerate()
            .find(|(_, td)| td.compare.is_some())
        {
            Some((idx, td)) => {
                let kind = td.compare.expect("guarded by find");
                let tz = crate::dates::parse_tz(query.timezone.as_deref())
                    .map_err(crate::compiler::CompileError::BadTimezone)?;
                let range = td.date_range.as_ref().expect("compare validated to carry a range");
                let (from, to) = crate::dates::resolve_date_range(range, now, tz)
                    .map_err(crate::compiler::CompileError::BadDateRange)?;
                let (prev_from, prev_to) = crate::dates::shift_window(&from, &to, kind)
                    .map_err(crate::compiler::CompileError::BadDateRange)?;
                let mut prev_query = query.clone();
                prev_query.time_dimensions[idx].date_range =
                    Some(crate::query::DateRange::Absolute([prev_from, prev_to]));
                prev_query.time_dimensions[idx].compare = None;
                prev_query.include_total = false;
                Some((idx, crate::compiler::compile_at(model, &prev_query, ctx, now)?))
            }
            None => None,
        };

        // Cache: keyed on SQL + params + the prev window's SQL/params + the
        // scope. Scope values already live in the params, but including the
        // map is belt and braces — a wrong-tenant cache hit is the one bug
        // this cache must never have. Relative windows expire naturally: the
        // resolved instants are in the params, so midnight changes the key.
        let cache_key = self.cache.as_ref().map(|_| {
            serde_json::to_string(&(
                &compiled.sql,
                &compiled.params,
                prev.as_ref().map(|(_, p)| (&p.sql, &p.params)),
                &ctx.scope,
                ctx.allow_unscoped,
            ))
            .unwrap_or_default()
        });
        if let (Some(cache), Some(key)) = (&self.cache, &cache_key) {
            if let Some(hit) = cache.get_at(key, Instant::now()) {
                return Ok(hit);
            }
        }

        let mut json_rows = self.fetch_json(&compiled.sql, &compiled.params, ctx).await?;

        // Pull the include_total window column out of the payload: it becomes
        // `total` on the result, never a visible column.
        use crate::compiler::TOTAL_ALIAS;
        let mut total = None;
        let mut columns = compiled.columns;
        if query.include_total {
            total = Some(
                json_rows
                    .first()
                    .and_then(|r| r.get(TOTAL_ALIAS))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            );
            for r in &mut json_rows {
                r.remove(TOTAL_ALIAS);
            }
            columns.retain(|c| c.key != TOTAL_ALIAS);
        }
        let has_more = total
            .map(|t| (query.offset.unwrap_or(0) as u64 + json_rows.len() as u64) < t)
            .unwrap_or(false);
        let truncated_at = match (clamped, self.max_rows) {
            (true, Some(max)) if json_rows.len() as u32 == max => Some(max),
            _ => None,
        };

        if let Some(exporter) = &self.exporter {
            let cube = query
                .measures
                .iter()
                .chain(query.dimensions.iter())
                .next()
                .and_then(|m| m.split('.').next())
                .map(|s| s.to_string());
            exporter.export(&QueryEvent {
                ts_ms: now_ms(),
                cube,
                measures: query.measures.clone(),
                dimensions: query.dimensions.clone(),
                filter_count: query.filters.len(),
                scope_keys: ctx.scope.keys().cloned().collect(),
                duration_ms: started.elapsed().as_millis() as u64,
                row_count: json_rows.len(),
            });
        }

        let mut result = QueryResult {
            columns,
            rows: json_rows,
            sql: Some(compiled.sql),
            total,
            has_more,
            truncated_at,
        };

        // Comparison window: execute the shifted query compiled above and
        // fold its measures in as `__prev_<measure>` columns.
        if let Some((idx, prev_compiled)) = &prev {
            let td = &query.time_dimensions[*idx];
            let prev_rows = self.fetch_json(&prev_compiled.sql, &prev_compiled.params, ctx).await?;
            let prev_result = QueryResult {
                columns: Vec::new(),
                rows: prev_rows,
                sql: None,
                total: None,
                has_more: false,
                truncated_at: None,
            };
            let time_key = td.granularity.is_some().then(|| td.dimension.clone());
            crate::compare::merge_prev(&mut result, &prev_result, &query.measures, time_key.as_deref());
        }

        if let (Some(cache), Some(key)) = (&self.cache, cache_key) {
            cache.put_at(key, result.clone(), Instant::now());
        }

        Ok(result)
    }

    /// The distinct-values query behind `/values`: scope-filtered,
    /// label-resolved values of one `filterable: true` dimension, with
    /// counts. Rows carry `value`, optional `label`, and `count`.
    pub async fn values(
        &self,
        model: &Model,
        member: &str,
        search: Option<&str>,
        limit: Option<u32>,
        ctx: &SecurityContext,
    ) -> Result<QueryResult, EngineError> {
        let compiled = crate::compiler::compile_values(model, member, search, limit, ctx)?;
        let rows = self.fetch_json(&compiled.sql, &compiled.params, ctx).await?;
        Ok(QueryResult {
            columns: compiled.columns,
            rows,
            sql: Some(compiled.sql),
            total: None,
            has_more: false,
            truncated_at: None,
        })
    }

    /// Bind params as TEXT and execute — shared by the main run and the
    /// comparison-window run. Binding as text avoids tokio-postgres
    /// mis-inferring parameter types; the compiler's `$n::type` casts coerce
    /// each value back to the column's type. Routes through the RLS
    /// transaction when configured and the query carries a tenant scope.
    async fn fetch_json(
        &self,
        sql: &str,
        params: &[ScalarValue],
        ctx: &SecurityContext,
    ) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, EngineError> {
        let boxed: Vec<Box<dyn ToSql + Sync>> = params
            .iter()
            .map(|v| -> Box<dyn ToSql + Sync> {
                match v {
                    ScalarValue::String(s) => Box::new(s.clone()),
                    ScalarValue::Int(i) => Box::new(i.to_string()),
                    ScalarValue::Float(f) => Box::new(f.to_string()),
                    ScalarValue::Bool(b) => Box::new(b.to_string()),
                    ScalarValue::Null => Box::new(Option::<String>::None),
                }
            })
            .collect();
        let typed: Vec<(&(dyn ToSql + Sync), Type)> = boxed
            .iter()
            .map(|b| (b.as_ref() as &(dyn ToSql + Sync), Type::TEXT))
            .collect();
        let workspace = self
            .rls
            .as_ref()
            .and_then(|_| ctx.scope.values().next())
            .map(scalar_text);
        let rows = match (&self.rls, workspace) {
            (Some(rls), Some(ws)) => self.run_rls(rls, sql, &typed, &ws).await?,
            _ => self.client.query_typed(sql, &typed).await?,
        };
        Ok(rows.iter().map(row_to_json).collect())
    }

    /// Execute one query under RLS: a fresh connection + transaction that pins
    /// the tenant GUC via `set_config(name, value, is_local => true)` before the
    /// select. Both GUC name and value are bound parameters (never
    /// interpolated), so this is injection-safe. Read-only, so the transaction
    /// is committed at the end (no writes to roll back).
    #[cfg(feature = "postgres")]
    async fn run_rls(
        &self,
        rls: &RlsConfig,
        sql: &str,
        typed: &[(&(dyn ToSql + Sync), Type)],
        workspace: &str,
    ) -> Result<Vec<Row>, EngineError> {
        let mut client = Self::connect_raw(&rls.conn_str).await?;
        let tx = client.transaction().await?;
        tx.execute("select set_config($1, $2, true)", &[&rls.guc, &workspace])
            .await?;
        let rows = tx.query_typed(sql, typed).await?;
        tx.commit().await?;
        Ok(rows)
    }
}

impl Engine for PostgresEngine {
    fn name(&self) -> &'static str {
        "postgres"
    }
}

/// Render a scope value as the text passed to `set_config` for the tenant GUC.
/// RLS policies cast it back (e.g. `current_setting('app.workspace_id')::int`).
fn scalar_text(v: &ScalarValue) -> String {
    match v {
        ScalarValue::String(s) => s.clone(),
        ScalarValue::Int(i) => i.to_string(),
        ScalarValue::Float(f) => f.to_string(),
        ScalarValue::Bool(b) => b.to_string(),
        ScalarValue::Null => String::new(),
    }
}

/// Map a row to a JSON object keyed by the selected `Cube.member` alias.
fn row_to_json(row: &Row) -> serde_json::Map<String, serde_json::Value> {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        obj.insert(col.name().to_string(), cell_to_json(row, i, col.type_()));
    }
    obj
}

fn cell_to_json(row: &Row, i: usize, ty: &Type) -> serde_json::Value {
    use serde_json::Value;
    match *ty {
        Type::BOOL => opt(row.try_get::<_, Option<bool>>(i).ok().flatten().map(Value::from)),
        Type::INT2 => opt(row.try_get::<_, Option<i16>>(i).ok().flatten().map(|v| Value::from(v as i64))),
        Type::INT4 => opt(row.try_get::<_, Option<i32>>(i).ok().flatten().map(|v| Value::from(v as i64))),
        Type::INT8 => opt(row.try_get::<_, Option<i64>>(i).ok().flatten().map(Value::from)),
        Type::FLOAT4 => opt(row.try_get::<_, Option<f32>>(i).ok().flatten().map(|v| Value::from(v as f64))),
        Type::FLOAT8 => opt(row.try_get::<_, Option<f64>>(i).ok().flatten().map(Value::from)),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => {
            opt(row.try_get::<_, Option<String>>(i).ok().flatten().map(Value::from))
        }
        // Compiled measures are cast to float8 and time dims to text, so other
        // types are rare; try text, then fall back to null.
        _ => opt(row.try_get::<_, Option<String>>(i).ok().flatten().map(Value::from)),
    }
}

fn opt(v: Option<serde_json::Value>) -> serde_json::Value {
    v.unwrap_or(serde_json::Value::Null)
}
