//! The driver-agnostic half of running a query: everything between "a query
//! arrived" and "rows came back" that is not talking to a database.
//!
//! [`plan_run`] clamps the row cap, compiles the current window and (for a
//! `compare` query) the shifted previous window against ONE clock.
//! [`assemble_run`] turns the rows a driver fetched into a [`QueryResult`]:
//! the `include_total` column becomes `total`, a filled cap becomes
//! `truncated_at`, and the previous window folds in as `__prev_<measure>`.
//!
//! Every engine — Postgres over tokio-postgres, DuckDB in a browser via the
//! WASM build — runs the same plan and assembly, so they cannot drift on what
//! a result means.

use crate::compiler::{CompileError, Compiled, Dialect, TOTAL_ALIAS};
use crate::context::SecurityContext;
use crate::model::Model;
use crate::query::{Query, QueryResult};

/// One JSON row, keyed by `Cube.member`.
pub type JsonRow = serde_json::Map<String, serde_json::Value>;

/// A query compiled and ready for any driver to execute.
#[derive(Debug, Clone)]
pub struct RunPlan {
    /// The query as executed — after the row cap was applied.
    pub query: Query,
    pub main: Compiled,
    pub prev: Option<PrevWindow>,
    /// The cap, when it clamped this query's limit.
    pub clamped_to: Option<u32>,
}

/// The comparison window of a `compare` query.
#[derive(Debug, Clone)]
pub struct PrevWindow {
    pub compiled: Compiled,
    /// The time member rows are aligned on; `None` for a single total row.
    pub time_key: Option<String>,
}

/// Compile `query` for execution. `max_rows` clamps an unbounded (or larger)
/// limit BEFORE compiling, so the cap happens in SQL.
pub fn plan_run(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
    now: chrono::DateTime<chrono::Utc>,
    dialect: Dialect,
    max_rows: Option<u32>,
) -> Result<RunPlan, CompileError> {
    let mut query = query.clone();
    let clamped_to = match max_rows {
        Some(max) if query.limit.is_none_or(|l| l > max) => {
            query.limit = Some(max);
            Some(max)
        }
        _ => None,
    };
    let main = crate::compiler::compile_at_for(model, &query, ctx, now, dialect)?;

    let prev = match query
        .time_dimensions
        .iter()
        .enumerate()
        .find(|(_, td)| td.compare.is_some())
    {
        Some((idx, td)) => {
            let kind = td.compare.expect("guarded by find");
            let tz = crate::dates::parse_tz(query.timezone.as_deref())
                .map_err(CompileError::BadTimezone)?;
            let range = td
                .date_range
                .as_ref()
                .expect("compare validated to carry a range");
            let (from, to) = crate::dates::resolve_date_range(range, now, tz)
                .map_err(CompileError::BadDateRange)?;
            let (prev_from, prev_to) =
                crate::dates::shift_window(&from, &to, kind).map_err(CompileError::BadDateRange)?;
            let time_key = td.granularity.is_some().then(|| td.dimension.clone());
            let mut prev_query = query.clone();
            prev_query.time_dimensions[idx].date_range =
                Some(crate::query::DateRange::Absolute([prev_from, prev_to]));
            prev_query.time_dimensions[idx].compare = None;
            prev_query.include_total = false;
            Some(PrevWindow {
                compiled: crate::compiler::compile_at_for(model, &prev_query, ctx, now, dialect)?,
                time_key,
            })
        }
        None => None,
    };

    Ok(RunPlan {
        query,
        main,
        prev,
        clamped_to,
    })
}

/// Build the result from the rows a driver fetched for `plan.main` and, for a
/// compare query, `plan.prev`.
pub fn assemble_run(
    plan: &RunPlan,
    mut rows: Vec<JsonRow>,
    prev_rows: Option<Vec<JsonRow>>,
) -> QueryResult {
    let query = &plan.query;
    let mut columns = plan.main.columns.clone();
    let mut total = None;
    if query.include_total {
        total = Some(
            rows.first()
                .and_then(|r| r.get(TOTAL_ALIAS))
                .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
                .unwrap_or(0),
        );
        for r in &mut rows {
            r.remove(TOTAL_ALIAS);
        }
        columns.retain(|c| c.key != TOTAL_ALIAS);
    }
    let has_more = total
        .map(|t| (query.offset.unwrap_or(0) as u64 + rows.len() as u64) < t)
        .unwrap_or(false);
    let truncated_at = plan
        .clamped_to
        .filter(|max| rows.len() as u32 == *max);

    let mut result = QueryResult {
        columns,
        rows,
        sql: Some(plan.main.sql.clone()),
        total,
        has_more,
        truncated_at,
    };

    if let (Some(prev), Some(prev_rows)) = (&plan.prev, prev_rows) {
        let prev_result = QueryResult {
            columns: Vec::new(),
            rows: prev_rows,
            sql: None,
            total: None,
            has_more: false,
            truncated_at: None,
        };
        crate::compare::merge_prev(
            &mut result,
            &prev_result,
            &query.measures,
            prev.time_key.as_deref(),
        );
    }
    result
}
