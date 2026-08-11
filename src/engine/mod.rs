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

/// A short-TTL in-process result cache. The key is built by the caller from
/// (compiled SQL, bound params, scope) — scope inclusion is what makes a
/// cache SAFE here: a cache that can return one tenant's rows to another is
/// worse than no cache. Time is injected (`get_at`/`put_at`) so expiry is
/// unit-testable without sleeping; the engine passes `Instant::now()`.
pub struct ResultCache {
    ttl: std::time::Duration,
    map: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, crate::query::QueryResult)>>,
}

impl ResultCache {
    /// Entries beyond this trigger an opportunistic prune on insert.
    const PRUNE_AT: usize = 512;

    pub fn new(ttl: std::time::Duration) -> Self {
        Self { ttl, map: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }

    pub fn get_at(&self, key: &str, now: std::time::Instant) -> Option<crate::query::QueryResult> {
        let map = self.map.lock().ok()?;
        let (stored_at, result) = map.get(key)?;
        (now.duration_since(*stored_at) < self.ttl).then(|| result.clone())
    }

    pub fn put_at(&self, key: String, result: crate::query::QueryResult, now: std::time::Instant) {
        if let Ok(mut map) = self.map.lock() {
            if map.len() >= Self::PRUNE_AT {
                map.retain(|_, (at, _)| now.duration_since(*at) < self.ttl);
            }
            map.insert(key, (now, result));
        }
    }
}

#[cfg(test)]
mod cache_tests {
    use super::ResultCache;
    use std::time::{Duration, Instant};

    fn result() -> crate::query::QueryResult {
        crate::query::QueryResult {
            columns: vec![],
            rows: vec![],
            sql: None,
            total: Some(7),
            has_more: false,
            truncated_at: None,
        }
    }

    #[test]
    fn hits_within_ttl_and_expires_after() {
        let cache = ResultCache::new(Duration::from_secs(30));
        let t0 = Instant::now();
        cache.put_at("k".into(), result(), t0);
        let hit = cache.get_at("k", t0 + Duration::from_secs(29)).expect("fresh hit");
        assert_eq!(hit.total, Some(7));
        assert!(cache.get_at("k", t0 + Duration::from_secs(31)).is_none(), "expired");
        assert!(cache.get_at("other", t0).is_none(), "different key");
    }
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
