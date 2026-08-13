//! ClickHouse engine — compiles for the ClickHouse dialect and executes over
//! the **HTTP interface**, mapping rows into JSON keyed by `Cube.member`.
//!
//! Why HTTP rather than the native protocol: the native protocol needs a
//! column-typed client, and this engine's results are dynamic (the model, not
//! the code, decides the columns). The HTTP interface takes server-side
//! parameters (`param_pN=…` bound against `{pN:String}` placeholders — never
//! string-interpolated, the same injection-safety-by-construction as the
//! Postgres engine) and returns `FORMAT JSON`, whose `data` rows are already
//! objects keyed by the selected alias. One dependency (`reqwest`), no driver.
//!
//! Feature parity with [`super::postgres::PostgresEngine`]: the row cap, the
//! `include_total` stripping, the comparison window, the result cache and the
//! query-log exporter all behave identically. What it does not have is an RLS
//! path — that is a Postgres defense (row-level-security policies over a
//! GUC), and pretending an equivalent here would claim a guarantee ClickHouse
//! does not offer. Tenant isolation is the compiler's fail-closed scope.

use super::{Engine, EngineError, ResultCache};
use crate::compiler::{compile_at_for, compile_values_for, Dialect, TOTAL_ALIAS};
use crate::context::SecurityContext;
use crate::logging::{now_ms, QueryEvent, QueryExporter};
use crate::model::Model;
use crate::query::{Query, QueryResult, ScalarValue};
use std::sync::Arc;
use std::time::Instant;

pub struct ClickHouseEngine {
    http: reqwest::Client,
    /// Base URL of the HTTP interface, e.g. `http://localhost:8123`.
    url: String,
    /// Sent as the `database` query parameter when set, so cube `sql_table`
    /// names stay unqualified and portable.
    database: Option<String>,
    /// Sent as `X-ClickHouse-User` / `X-ClickHouse-Key` when set.
    user: Option<String>,
    password: Option<String>,
    exporter: Option<Arc<dyn QueryExporter>>,
    /// Hard cap on returned rows; results that fill it report `truncated_at`.
    max_rows: Option<u32>,
    cache: Option<ResultCache>,
}

/// The shape `FORMAT JSON` returns: rows keyed by alias (plus metadata this
/// engine does not need — the compiler already knows the columns).
#[derive(serde::Deserialize)]
struct JsonResponse {
    #[serde(default)]
    data: Vec<serde_json::Map<String, serde_json::Value>>,
}

impl ClickHouseEngine {
    /// Point the engine at an HTTP interface URL. No connection is opened —
    /// HTTP is stateless, so a bad URL surfaces on the first query (or
    /// [`ping`](Self::ping)).
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            url: url.into(),
            database: None,
            user: None,
            password: None,
            exporter: None,
            max_rows: None,
            cache: None,
        }
    }

    /// Run every query against this database.
    pub fn with_database(mut self, database: impl Into<String>) -> Self {
        self.database = Some(database.into());
        self
    }

    /// Authenticate as `user` (password optional — ClickHouse's `default`
    /// user often has none).
    pub fn with_auth(mut self, user: impl Into<String>, password: Option<String>) -> Self {
        self.user = Some(user.into());
        self.password = password;
        self
    }

    /// Attach a query-log exporter — every executed query is recorded.
    pub fn with_exporter(mut self, exporter: Arc<dyn QueryExporter>) -> Self {
        self.exporter = Some(exporter);
        self
    }

    /// Cap every result at `max` rows, clamped in SQL before execution. A
    /// result that fills the cap reports `truncated_at` — never a silently
    /// complete-looking page.
    pub fn with_max_rows(mut self, max: u32) -> Self {
        self.max_rows = Some(max);
        self
    }

    /// Cache results for `ttl`. The key covers SQL, params, the comparison
    /// window and the scope — a wrong-tenant cache hit is the one bug this
    /// cache must never have.
    pub fn with_cache(mut self, ttl: std::time::Duration) -> Self {
        self.cache = Some(ResultCache::new(ttl));
        self
    }

    /// `select 1` — is the server there and are the credentials right?
    pub async fn ping(&self) -> Result<(), EngineError> {
        self.fetch_json("select 1", &[]).await.map(|_| ())
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
        // the cap happens in SQL, and remember that we did.
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
        let compiled = compile_at_for(model, query, ctx, now, Dialect::ClickHouse)?;

        // Comparison window, compiled UP FRONT so the cache key covers it.
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
                let range = td
                    .date_range
                    .as_ref()
                    .expect("compare validated to carry a range");
                let (from, to) = crate::dates::resolve_date_range(range, now, tz)
                    .map_err(crate::compiler::CompileError::BadDateRange)?;
                let (prev_from, prev_to) = crate::dates::shift_window(&from, &to, kind)
                    .map_err(crate::compiler::CompileError::BadDateRange)?;
                let mut prev_query = query.clone();
                prev_query.time_dimensions[idx].date_range =
                    Some(crate::query::DateRange::Absolute([prev_from, prev_to]));
                prev_query.time_dimensions[idx].compare = None;
                prev_query.include_total = false;
                Some((
                    idx,
                    compile_at_for(model, &prev_query, ctx, now, Dialect::ClickHouse)?,
                ))
            }
            None => None,
        };

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

        let mut json_rows = self.fetch_json(&compiled.sql, &compiled.params).await?;

        // Pull the include_total window column out of the payload: it becomes
        // `total` on the result, never a visible column.
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
            let prev_rows = self
                .fetch_json(&prev_compiled.sql, &prev_compiled.params)
                .await?;
            let prev_result = QueryResult {
                columns: Vec::new(),
                rows: prev_rows,
                sql: None,
                total: None,
                has_more: false,
                truncated_at: None,
            };
            let time_key = td.granularity.is_some().then(|| td.dimension.clone());
            crate::compare::merge_prev(
                &mut result,
                &prev_result,
                &query.measures,
                time_key.as_deref(),
            );
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
        let compiled = compile_values_for(model, member, search, limit, ctx, Dialect::ClickHouse)?;
        let rows = self.fetch_json(&compiled.sql, &compiled.params).await?;
        Ok(QueryResult {
            columns: compiled.columns,
            rows,
            sql: Some(compiled.sql),
            total: None,
            has_more: false,
            truncated_at: None,
        })
    }

    /// POST one statement with its parameters and parse the JSON rows.
    async fn fetch_json(
        &self,
        sql: &str,
        params: &[ScalarValue],
    ) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, EngineError> {
        let mut request = self
            .http
            .post(&self.url)
            // Int64/UInt64 arrive as JSON strings unless told otherwise —
            // `count(*)` as `"6"` is the kind of surprise every caller would
            // then re-fix.
            .query(&[("output_format_json_quote_64bit_integers", "0")]);
        if let Some(database) = &self.database {
            request = request.query(&[("database", database.as_str())]);
        }
        if let Some(user) = &self.user {
            request = request.header("X-ClickHouse-User", user);
            if let Some(password) = &self.password {
                request = request.header("X-ClickHouse-Key", password);
            }
        }
        // Every value travels as text, exactly like the Postgres engine's
        // bind-as-text strategy; the compiled SQL carries the coercion.
        for (i, value) in params.iter().enumerate() {
            request = request.query(&[(format!("param_p{}", i + 1), scalar_text(value))]);
        }

        let response = request.body(format!("{sql}\nFORMAT JSON")).send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let message = response.text().await.unwrap_or_default();
            return Err(EngineError::ClickHouse(format!(
                "{status}: {}",
                message.trim()
            )));
        }

        let parsed: JsonResponse = response.json().await?;
        Ok(parsed.data)
    }
}

impl Engine for ClickHouseEngine {
    fn name(&self) -> &'static str {
        "clickhouse"
    }

    fn dialect(&self) -> Dialect {
        Dialect::ClickHouse
    }
}

/// Render a scalar as the text bound to a `{pN:String}` parameter. `Null`
/// becomes the empty string — a documented v1 limitation, acceptable because
/// filters on null use `set`/`notSet` (no parameter) rather than a null value.
fn scalar_text(v: &ScalarValue) -> String {
    match v {
        ScalarValue::String(s) => s.clone(),
        ScalarValue::Int(i) => i.to_string(),
        ScalarValue::Float(f) => f.to_string(),
        ScalarValue::Bool(b) => b.to_string(),
        ScalarValue::Null => String::new(),
    }
}
