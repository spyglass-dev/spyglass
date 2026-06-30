//! The Cube-style data model — how metrics and measures are defined.
//!
//! A [`Model`] is a set of [`Cube`]s. Each cube maps to one base relation
//! (`sql_table`, or an inline `sql` subquery) and declares **measures**
//! (aggregations) and **dimensions** (group-by / filter columns). This mirrors
//! Cube's modeling format closely enough that definitions are portable, while
//! staying a small, dependency-light Rust struct we own.
//!
//! Definitions are authored as YAML/JSON and loaded by [`crate::loader`].

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A whole reporting model: named cubes. `BTreeMap` keeps iteration
/// deterministic (important for stable compiled SQL + tests).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Model {
    #[serde(default)]
    pub cubes: BTreeMap<String, Cube>,
}

impl Model {
    pub fn cube(&self, name: &str) -> Option<&Cube> {
        self.cubes.get(name)
    }

    /// Merge another model's cubes in (later wins). Used to layer host
    /// (Zippy) cubes on top of base ones, or to load a directory of files.
    pub fn merge(&mut self, other: Model) {
        for (k, v) in other.cubes {
            self.cubes.insert(k, v);
        }
    }
}

/// One cube — a queryable entity backed by a base relation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cube {
    /// Cube name (also the member prefix, e.g. `Submissions.count`). Under a
    /// `cubes:` map it's backfilled from the map key by the loader, so cube
    /// definitions don't repeat it; a single-cube file sets it explicitly.
    #[serde(default)]
    pub name: String,
    /// Base table name. Exactly one of `sql_table` / `sql` should be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql_table: Option<String>,
    /// Inline base SQL (a subquery), used when there's no single table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub measures: BTreeMap<String, Measure>,
    #[serde(default)]
    pub dimensions: BTreeMap<String, Dimension>,
}

impl Cube {
    /// The `FROM` source for this cube (table name or `(sql)`).
    pub fn from_source(&self) -> Option<String> {
        if let Some(t) = &self.sql_table {
            Some(t.clone())
        } else {
            self.sql.as_ref().map(|s| format!("({s})"))
        }
    }
}

/// How a measure aggregates. Mirrors Cube's measure types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasureType {
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
    /// A raw numeric expression with no aggregation wrapper.
    Number,
}

/// A measure: an aggregation over the cube's rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Measure {
    #[serde(rename = "type")]
    pub measure_type: MeasureType,
    /// Column/expression to aggregate. Omitted for `count`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Display format hint for the UI (e.g. `percent`, `number`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// Dimension value type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionType {
    String,
    Number,
    Time,
    Boolean,
}

/// A dimension: a column to group by or filter on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dimension {
    #[serde(rename = "type")]
    pub dimension_type: DimensionType,
    /// Column/expression. Defaults to the dimension key if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Marks the tenant/scope column (e.g. `workspace_id`). The security
    /// context's scope filters are matched against members; this flag lets
    /// callers/tools discover which dimension carries the tenant.
    #[serde(default, skip_serializing_if = "is_false")]
    pub tenant: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}
