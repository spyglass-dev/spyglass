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

/// A time dimension with optional truncation + range.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeDimension {
    pub dimension: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granularity: Option<Granularity>,
    /// `[from, to]` ISO timestamps (inclusive lower, exclusive upper).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range: Option<[String; 2]>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    /// `Cube.member` key.
    pub key: String,
    /// `measure` | `dimension` | `time`.
    pub kind: String,
}
