//! Engines — pluggable execution backends, selected by crate feature flags.
//!
//! Every engine shares the pure [`crate::compiler`] to turn a query into a
//! parameterized statement; an engine adds the dialect + execution. `postgres`
//! is the default feature; future engines (DuckDB, BigQuery, …) plug in here
//! behind their own flags without changing the model, query, or UI.

use crate::compiler::{CompileError, Compiled};
use crate::context::SecurityContext;
use crate::model::Model;
use crate::query::Query;

#[cfg(feature = "postgres")]
pub mod postgres;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Compile(#[from] CompileError),
    #[cfg(feature = "postgres")]
    #[error("postgres error: {0}")]
    Postgres(#[from] tokio_postgres::Error),
}

/// Shared, synchronous compile step. Execution is engine-specific (async).
pub trait Engine {
    /// Engine identifier (`postgres`, …) — surfaced in diagnostics.
    fn name(&self) -> &'static str;

    /// Compile a query against the model + scope into a statement. Engines
    /// inject the real clock here — relative date ranges resolve against it,
    /// while the compiler itself never reads system time.
    fn compile(
        &self,
        model: &Model,
        query: &Query,
        ctx: &SecurityContext,
    ) -> Result<Compiled, CompileError> {
        crate::compiler::compile_at(model, query, ctx, chrono::Utc::now())
    }
}
