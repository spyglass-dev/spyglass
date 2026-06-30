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
    exporter: Option<Arc<dyn QueryExporter>>,
}

impl PostgresEngine {
    /// Wrap an existing client (e.g. one the host already manages).
    pub fn new(client: Client) -> Self {
        Self { client, exporter: None }
    }

    /// Attach a query-log exporter — every executed query is recorded.
    pub fn with_exporter(mut self, exporter: Arc<dyn QueryExporter>) -> Self {
        self.exporter = Some(exporter);
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
        Ok(Self { client, exporter: None })
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

        let rows = self.client.query_typed(&compiled.sql, &typed).await?;
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
}

impl Engine for PostgresEngine {
    fn name(&self) -> &'static str {
        "postgres"
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
