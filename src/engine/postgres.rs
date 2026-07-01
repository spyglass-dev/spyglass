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
        Self { client, conn_str: None, rls: None, exporter: None }
    }

    /// Attach a query-log exporter — every executed query is recorded.
    pub fn with_exporter(mut self, exporter: Arc<dyn QueryExporter>) -> Self {
        self.exporter = Some(exporter);
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
        let compiled = self.compile(model, query, ctx)?;

        // Bind every param as TEXT (never string-interpolated). The compiler
        // casts each placeholder to the column's type (`$n::numeric`,
        // `$n::timestamptz`, …), so binding as text avoids tokio-postgres
        // mis-inferring an `int4`/`timestamptz` column from an `i64`/`String`
        // Rust value (which fails with "error serializing parameter").
        let boxed: Vec<Box<dyn ToSql + Sync>> = compiled
            .params
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
        // Declare every parameter as TEXT so Postgres does not re-infer its
        // type from the column; the compiler's `$n::numeric`/`$n::timestamptz`
        // casts then coerce the text value to the column's type.
        let typed: Vec<(&(dyn ToSql + Sync), Type)> = boxed
            .iter()
            .map(|b| (b.as_ref() as &(dyn ToSql + Sync), Type::TEXT))
            .collect();

        // RLS path: when configured AND the query carries a tenant scope value,
        // run in a transaction that pins the GUC first so database policies
        // enforce isolation. Non-tenant queries (no scope) and engines without
        // RLS use the shared client directly.
        let workspace = self
            .rls
            .as_ref()
            .and_then(|_| ctx.scope.values().next())
            .map(scalar_text);
        let rows = match (&self.rls, workspace) {
            (Some(rls), Some(ws)) => self.run_rls(rls, &compiled.sql, &typed, &ws).await?,
            _ => self.client.query_typed(&compiled.sql, &typed).await?,
        };
        let json_rows: Vec<_> = rows.iter().map(|r| row_to_json(r)).collect();

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

        Ok(QueryResult {
            columns: compiled.columns,
            rows: json_rows,
            sql: Some(compiled.sql),
        })
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
