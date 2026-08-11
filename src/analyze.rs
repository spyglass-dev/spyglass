//! Database analysis — go beyond structure and *profile the data* so an agent
//! can build good cubes: row counts, null fractions, cardinality, value ranges,
//! and top values for categorical columns. Postgres first.
//!
//! Runs read-only aggregate queries via a `tokio_postgres::Client` (the engine's
//! connection, or a fresh one from a DB URL). An optional `filter` scopes every
//! profiling query (e.g. `workspace_id = '…'`) so analysis can be tenant-safe.

use serde::{Deserialize, Serialize};

use crate::introspect::RawSchema;

/// Restrict profiling to rows matching `column = value` (applied to any table
/// that has the column). Use for tenant-scoped analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeFilter {
    pub column: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeOptions {
    /// Limit to these tables (default: all public tables).
    #[serde(default)]
    pub tables: Option<Vec<String>>,
    /// Profile column values (null counts, cardinality, top values, ranges).
    /// When false, only schema + per-table row counts are returned.
    #[serde(default)]
    pub profile_values: bool,
    /// Top-N values to sample for categorical columns.
    #[serde(default = "default_top_k")]
    pub top_k: i64,
    /// Skip `count(distinct …)` on tables larger than this (it's expensive).
    #[serde(default = "default_large_rows")]
    pub large_table_rows: i64,
    /// Optional tenant scope applied to every query.
    #[serde(default)]
    pub filter: Option<AnalyzeFilter>,
}

fn default_top_k() -> i64 {
    10
}
fn default_large_rows() -> i64 {
    1_000_000
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            tables: None,
            profile_values: false,
            top_k: default_top_k(),
            large_table_rows: default_large_rows(),
            filter: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopValue {
    pub value: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnProfile {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub null_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distinct_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_values: Vec<TopValue>,
    /// Suggested cube role from the profile: `dimension` | `measure` | `id` | `skip`.
    pub suggested_role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableProfile {
    pub name: String,
    pub row_count: i64,
    pub columns: Vec<ColumnProfile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DbProfile {
    pub tables: Vec<TableProfile>,
}

/// Column shape, derived from the SQL data type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnClass {
    Categorical,
    Numeric,
    Temporal,
    Other,
}

pub fn classify(data_type: &str) -> ColumnClass {
    match data_type {
        "text" | "character varying" | "character" | "name" | "uuid" | "citext" => {
            ColumnClass::Categorical
        }
        "boolean" => ColumnClass::Categorical,
        "smallint" | "integer" | "bigint" | "numeric" | "real" | "double precision" | "decimal" => {
            ColumnClass::Numeric
        }
        t if t.starts_with("timestamp") || t == "date" || t.starts_with("time") => {
            ColumnClass::Temporal
        }
        _ => ColumnClass::Other,
    }
}

/// Suggest a cube role from name + class + cardinality (heuristic, advisory).
fn suggest_role(
    name: &str,
    class: ColumnClass,
    distinct: Option<i64>,
    row_count: i64,
) -> &'static str {
    if name == "id" || name.ends_with("_id") {
        return "id";
    }
    match class {
        ColumnClass::Numeric => "measure",
        ColumnClass::Temporal => "dimension",
        ColumnClass::Categorical => {
            // Low-cardinality text → a good group-by dimension.
            match distinct {
                Some(d) if d > 0 && (d as f64) <= (row_count as f64).max(1.0) * 0.5 => "dimension",
                _ => "dimension",
            }
        }
        ColumnClass::Other => "skip",
    }
}

/// Quote a Postgres identifier.
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(feature = "postgres")]
mod exec {
    use super::*;
    use tokio_postgres::Client;

    fn where_clause(table_cols: &[String], filter: &Option<AnalyzeFilter>) -> (String, bool) {
        match filter {
            Some(f) if table_cols.iter().any(|c| c == &f.column) => {
                (format!(" where {} = $1", quote_ident(&f.column)), true)
            }
            _ => (String::new(), false),
        }
    }

    pub async fn analyze(
        client: &Client,
        opts: &AnalyzeOptions,
    ) -> Result<DbProfile, tokio_postgres::Error> {
        let schema = RawSchema::introspect(client).await?;
        let mut out = DbProfile::default();

        for table in &schema.tables {
            if let Some(only) = &opts.tables {
                if !only.iter().any(|t| t == &table.name) {
                    continue;
                }
            }
            let cols: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();
            let (wsql, has_param) = where_clause(&cols, &opts.filter);
            let tq = quote_ident(&table.name);

            // Row count (scoped).
            let row_count: i64 = {
                let sql = format!("select count(*)::int8 from {tq}{wsql}");
                let row = run_one(client, &sql, has_param, &opts.filter).await?;
                row.get::<_, i64>(0)
            };

            let mut columns = Vec::with_capacity(table.columns.len());
            for col in &table.columns {
                let class = classify(&col.data_type);
                let mut profile = ColumnProfile {
                    name: col.name.clone(),
                    data_type: col.data_type.clone(),
                    nullable: col.nullable,
                    null_count: None,
                    distinct_count: None,
                    min: None,
                    max: None,
                    top_values: Vec::new(),
                    suggested_role: "dimension".to_string(),
                };

                if opts.profile_values && class != ColumnClass::Other && row_count > 0 {
                    let cq = quote_ident(&col.name);
                    // Null count (+ distinct when the table isn't huge).
                    let want_distinct = row_count <= opts.large_table_rows;
                    let sql = if want_distinct {
                        format!("select (count(*) - count({cq}))::int8, count(distinct {cq})::int8 from {tq}{wsql}")
                    } else {
                        format!("select (count(*) - count({cq}))::int8 from {tq}{wsql}")
                    };
                    let row = run_one(client, &sql, has_param, &opts.filter).await?;
                    profile.null_count = Some(row.get::<_, i64>(0));
                    if want_distinct {
                        profile.distinct_count = Some(row.get::<_, i64>(1));
                    }

                    match class {
                        ColumnClass::Categorical => {
                            let sql = format!(
                                "select {cq}::text, count(*)::int8 from {tq}{wsql} group by {cq} order by 2 desc nulls last limit {}",
                                opts.top_k.max(1)
                            );
                            let rows = run_many(client, &sql, has_param, &opts.filter).await?;
                            profile.top_values = rows
                                .iter()
                                .map(|r| TopValue {
                                    value: r.get::<_, Option<String>>(0),
                                    count: r.get::<_, i64>(1),
                                })
                                .collect();
                        }
                        ColumnClass::Numeric | ColumnClass::Temporal => {
                            let sql =
                                format!("select min({cq})::text, max({cq})::text from {tq}{wsql}");
                            let row = run_one(client, &sql, has_param, &opts.filter).await?;
                            profile.min = row.get::<_, Option<String>>(0);
                            profile.max = row.get::<_, Option<String>>(1);
                        }
                        ColumnClass::Other => {}
                    }
                }

                profile.suggested_role =
                    suggest_role(&col.name, class, profile.distinct_count, row_count).to_string();
                columns.push(profile);
            }

            out.tables.push(TableProfile {
                name: table.name.clone(),
                row_count,
                columns,
            });
        }
        Ok(out)
    }

    async fn run_one(
        client: &Client,
        sql: &str,
        has_param: bool,
        filter: &Option<AnalyzeFilter>,
    ) -> Result<tokio_postgres::Row, tokio_postgres::Error> {
        if has_param {
            let v = &filter.as_ref().unwrap().value;
            client.query_one(sql, &[v]).await
        } else {
            client.query_one(sql, &[]).await
        }
    }

    async fn run_many(
        client: &Client,
        sql: &str,
        has_param: bool,
        filter: &Option<AnalyzeFilter>,
    ) -> Result<Vec<tokio_postgres::Row>, tokio_postgres::Error> {
        if has_param {
            let v = &filter.as_ref().unwrap().value;
            client.query(sql, &[v]).await
        } else {
            client.query(sql, &[]).await
        }
    }
}

#[cfg(feature = "postgres")]
pub use exec::analyze;
