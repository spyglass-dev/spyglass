//! Query logging — a pluggable exporter for every query the engine runs, plus
//! a processor that turns the log into usage stats.
//!
//! In a real deployment this is how the system learns what's actually asked:
//! the JSON exporter writes one event per query to `logs/`, and
//! [`analyze_log`] aggregates them (most-used cubes/measures/dimensions, query
//! volume, latency) — signal an agent can use to suggest metrics, pre-build
//! reports, or prioritize cube coverage. Dependency-free (std only).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One executed-query event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryEvent {
    /// Unix epoch milliseconds.
    pub ts_ms: u64,
    /// The cube the query targeted (member prefix), if resolvable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cube: Option<String>,
    pub measures: Vec<String>,
    pub dimensions: Vec<String>,
    /// Number of filters the caller supplied (not the values — never logged).
    pub filter_count: usize,
    /// Scope members applied (keys only — never the tenant values).
    pub scope_keys: Vec<String>,
    pub duration_ms: u64,
    pub row_count: usize,
}

/// A sink for query events. Implement to ship events anywhere; the bundled
/// [`JsonFileExporter`] writes JSON lines to disk.
pub trait QueryExporter: Send + Sync {
    fn export(&self, event: &QueryEvent);
}

/// Appends each event as a JSON line to `<dir>/reporting-queries.jsonl`.
pub struct JsonFileExporter {
    path: PathBuf,
}

impl JsonFileExporter {
    /// Create an exporter writing into `dir` (created if missing).
    pub fn new(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            path: dir.join("reporting-queries.jsonl"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl QueryExporter for JsonFileExporter {
    fn export(&self, event: &QueryEvent) {
        let Ok(line) = serde_json::to_string(event) else {
            return;
        };
        // Best-effort, non-fatal: a logging failure must never fail a query.
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Aggregated view of past usage — the "understanding" pass over the log.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageStats {
    pub total_queries: usize,
    pub by_cube: BTreeMap<String, usize>,
    pub by_measure: BTreeMap<String, usize>,
    pub by_dimension: BTreeMap<String, usize>,
    pub avg_duration_ms: f64,
    pub avg_row_count: f64,
}

/// Parse a JSONL query log into [`UsageStats`]. Malformed lines are skipped.
pub fn analyze_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> UsageStats {
    let mut stats = UsageStats::default();
    let mut total_duration: u64 = 0;
    let mut total_rows: usize = 0;
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<QueryEvent>(line) else {
            continue;
        };
        stats.total_queries += 1;
        total_duration += ev.duration_ms;
        total_rows += ev.row_count;
        if let Some(cube) = &ev.cube {
            *stats.by_cube.entry(cube.clone()).or_insert(0) += 1;
        }
        for m in &ev.measures {
            *stats.by_measure.entry(m.clone()).or_insert(0) += 1;
        }
        for d in &ev.dimensions {
            *stats.by_dimension.entry(d.clone()).or_insert(0) += 1;
        }
    }
    if stats.total_queries > 0 {
        stats.avg_duration_ms = total_duration as f64 / stats.total_queries as f64;
        stats.avg_row_count = total_rows as f64 / stats.total_queries as f64;
    }
    stats
}

/// Read + analyze a JSONL query log file.
pub fn analyze_log(path: impl AsRef<Path>) -> std::io::Result<UsageStats> {
    let contents = std::fs::read_to_string(path)?;
    Ok(analyze_lines(contents.lines()))
}

/// Current Unix epoch in milliseconds (helper for building events).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
