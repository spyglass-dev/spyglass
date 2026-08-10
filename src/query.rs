//! The query format — what a caller (or the agent) sends to the engine.
//!
//! Cube-shaped: `measures` and `dimensions` are `Cube.member` strings,
//! `filters` and `time_dimensions` reference members, and the result is a set
//! of rows. This is the JSON the agent authors against the reporting endpoint.

use serde::{Deserialize, Serialize};

/// A single analytics query.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// `Cube.measure` members to aggregate.
    #[serde(default)]
    pub measures: Vec<String>,
    /// `Cube.dimension` members to group by.
    #[serde(default)]
    pub dimensions: Vec<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub time_dimensions: Vec<TimeDimension>,
    #[serde(default)]
    pub order: Vec<Order>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Rows to skip before the first returned row (server-driven paging).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// Ask for the total row count via one `count(*) over ()` window column —
    /// one query, not two; on a grouped query it counts *groups*, which is
    /// what "1–25 of 312" means. Returned as `QueryResult.total`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub include_total: bool,
    /// `aggregate` (default) groups and aggregates; `rows` returns row-level
    /// records, projecting only the cube's published `drill_members`.
    #[serde(default, skip_serializing_if = "is_default_mode")]
    pub mode: QueryMode,
    /// IANA timezone (e.g. `Europe/London`) relative date expressions are
    /// evaluated in. Defaults to UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Named cube predicates to apply (`"Cube.segment"`). Each compiles into
    /// the WHERE clause; a segment's cube participates in the query like any
    /// referenced cube (joins and tenant scope included).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<String>,
}

/// How a query reads the cube: aggregated (the default) or row-level.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryMode {
    #[default]
    Aggregate,
    /// Row-level records. No grouping; the projection is restricted to the
    /// cube's `drill_members` (its published record shape and PII boundary).
    Rows,
}

fn is_default_mode(m: &QueryMode) -> bool {
    *m == QueryMode::Aggregate
}

impl Query {
    /// Every member referenced by the query (used to resolve the cube).
    pub fn members(&self) -> impl Iterator<Item = &str> {
        self.measures
            .iter()
            .chain(self.dimensions.iter())
            .chain(self.time_dimensions.iter().map(|t| &t.dimension))
            .map(|s| s.as_str())
    }
}

/// Filter operators — a practical subset of Cube's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    Equals,
    NotEquals,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    NotIn,
    Contains,
    Set,
    NotSet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filter {
    pub member: String,
    pub operator: FilterOperator,
    #[serde(default)]
    pub values: Vec<ScalarValue>,
}

/// A time dimension with optional truncation + range. With a `granularity`
/// it is projected and grouped as buckets; **without one it is filter-only**
/// (the `date_range` applies, nothing is projected) — matching Cube's
/// semantics, and what lets a metric query carry a comparison window.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeDimension {
    pub dimension: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
    /// Either `[from, to]` ISO timestamps (inclusive lower, exclusive upper)
    /// or a relative expression (`"last 30 days"`, `"this month"`,
    /// `"previous quarter"`, `"ytd"`) resolved server-side against an
    /// injected clock in the query's `timezone` — so a saved document stores
    /// the *intent* and the window moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range: Option<DateRange>,
    /// Run the same query over a shifted window and return
    /// `__prev_<measure>` columns alongside — real deltas for metrics, a
    /// ghost series for charts. Requires a `date_range`; the time dimension
    /// must be the query's only grouping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare: Option<Compare>,
    /// Fill empty buckets with 0 via a `generate_series` join, so gaps
    /// appear instead of vanishing. Requires `granularity` + `date_range`;
    /// the time dimension must be the query's only grouping.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fill_gaps: bool,
}

/// Which shifted window `compare` runs over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Compare {
    /// The window immediately before this one, same width.
    PreviousPeriod,
    /// The same window one calendar year earlier.
    PreviousYear,
}

/// Prefix of the comparison columns (`__prev_Orders.count`), column kind
/// `prev_measure`.
pub const PREV_PREFIX: &str = "__prev_";

/// An absolute `[from, to)` pair, or a relative expression the server
/// resolves at run time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DateRange {
    Absolute([String; 2]),
    Relative(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Hour,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl Granularity {
    /// The `generate_series` step for one bucket of this granularity.
    pub fn series_step(&self) -> &'static str {
        match self {
            Granularity::Hour => "1 hour",
            Granularity::Day => "1 day",
            Granularity::Week => "1 week",
            Granularity::Month => "1 month",
            // Postgres intervals have no 'quarter' unit.
            Granularity::Quarter => "3 months",
            Granularity::Year => "1 year",
        }
    }

    pub fn as_pg(&self) -> &'static str {
        match self {
            Granularity::Hour => "hour",
            Granularity::Day => "day",
            Granularity::Week => "week",
            Granularity::Month => "month",
            Granularity::Quarter => "quarter",
            Granularity::Year => "year",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub member: String,
    #[serde(default)]
    pub desc: bool,
}

/// A scalar filter/parameter value. Kept engine-agnostic; the Postgres
/// engine maps these to bind parameters (never string-interpolated).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ScalarValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Null,
}

/// The result of a query: ordered columns + JSON rows keyed by member.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    /// The compiled SQL — handy for debugging / transparency (never the
    /// raw schema; just the generated statement).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// Total matching rows/groups, present when the query asked
    /// `include_total`. Counted by the same statement (`count(*) over ()`),
    /// so it reflects filters and scope, not the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// True when rows beyond this page exist (`offset + rows.len() < total`).
    /// Only meaningful when `total` is known; false otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_more: bool,
    /// Set when the engine's row cap clamped an unbounded (or larger) request
    /// and the result hit the cap — so a UI can tell a truncated table from a
    /// complete one instead of presenting a silent cutoff as the whole story.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated_at: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    /// `Cube.member` key.
    pub key: String,
    /// `measure` | `dimension` | `time`.
    pub kind: String,
    /// The projected dimension's `drill: { entity }` annotation, so a result
    /// consumer can wire entity navigation without re-joining `/meta`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drill_entity: Option<String>,
}

impl Column {
    pub fn new(key: impl Into<String>, kind: impl Into<String>) -> Self {
        Self { key: key.into(), kind: kind.into(), drill_entity: None }
    }
}
