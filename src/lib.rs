//! # Spyglass
//!
//! A small, pluggable semantic layer. Define metrics and measures in a
//! Cube-style [`model`], send a Cube-shaped [`query`], and the engine compiles
//! it to parameterized SQL ([`compiler`]) and runs it on a pluggable backend
//! ([`engine`], Postgres by default). A [`context::SecurityContext`] scopes
//! every query to a tenant so raw tables are never exposed and callers can't
//! escape their scope.
//!
//! The crate is intentionally dependency-light, self-contained, and
//! **domain-agnostic** — designed to be lifted out and open-sourced. The host
//! provides the cube definitions, a DB client, and the security context.
//!
//! ## The Spyglass ecosystem (nautical map)
//!
//! | Component  | Role                | Where it lives today          |
//! |------------|---------------------|-------------------------------|
//! | spyglass   | semantic layer      | this crate ([`model`]/[`query`]/[`context`]) |
//! | sextant    | SQL generator       | [`compiler`]                  |
//! | compass    | metadata / catalog  | [`introspect`] (+ [`loader`]) |
//! | telescope  | query planner       | (folded into `compiler` for now) |
//! | harbor     | cache               | (planned)                     |
//! | captain    | orchestration       | [`engine`] (+ host)           |

pub mod analyze;
pub mod compiler;
pub mod compare;
pub mod context;
pub mod dates;
pub mod engine;
pub mod introspect;
pub mod loader;
pub mod logging;
pub mod meta;
pub mod model;
pub mod query;
pub mod report;

pub use compiler::{compile, compile_at, CompileError, Compiled};
pub use context::SecurityContext;
pub use analyze::{AnalyzeFilter, AnalyzeOptions, ColumnProfile, DbProfile, TableProfile};
pub use introspect::{ColumnDef, RawSchema, TableDef};
pub use meta::{CubeMeta, DimensionMeta, JoinMeta, MeasureMeta, ModelMeta, SegmentMeta};
pub use report::{resolve_widget, BoundReport, BoundWidget, ChartHint};
pub use logging::{analyze_log, analyze_lines, JsonFileExporter, QueryEvent, QueryExporter, UsageStats};
pub use model::{
    Cube, Dimension, DimensionType, DrillTarget, Join, JoinRelationship, Measure, MeasureType,
    Model, Segment,
};
pub use query::{
    Column, Compare, DateRange, Filter, FilterOperator, Granularity, Order, Query,
    QueryMode, QueryResult, ScalarValue, TimeDimension, PREV_PREFIX,
};

#[cfg(feature = "postgres")]
pub use engine::postgres::PostgresEngine;
