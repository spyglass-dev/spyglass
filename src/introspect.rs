//! Schema introspection — pull the raw table/column definitions from a live
//! Postgres so an agent (or CLI) can map them into cube definitions
//! automatically. Reads `information_schema.columns` for the public schema; it
//! never exposes data, only structure.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDef {
    pub name: String,
    /// Postgres data type (`text`, `integer`, `timestamp with time zone`, …).
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDef {
    pub name: String,
    pub columns: Vec<ColumnDef>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RawSchema {
    pub tables: Vec<TableDef>,
}

#[cfg(feature = "postgres")]
impl RawSchema {
    /// Introspect the `public` schema of a live database.
    pub async fn introspect(
        client: &tokio_postgres::Client,
    ) -> Result<RawSchema, tokio_postgres::Error> {
        let rows = client
            .query(
                "select table_name, column_name, data_type, is_nullable \
                 from information_schema.columns \
                 where table_schema = 'public' \
                 order by table_name, ordinal_position",
                &[],
            )
            .await?;

        let mut by_table: BTreeMap<String, Vec<ColumnDef>> = BTreeMap::new();
        for row in &rows {
            let table: String = row.get(0);
            let column: String = row.get(1);
            let data_type: String = row.get(2);
            let is_nullable: String = row.get(3);
            by_table.entry(table).or_default().push(ColumnDef {
                name: column,
                data_type,
                nullable: is_nullable.eq_ignore_ascii_case("yes"),
            });
        }
        Ok(RawSchema {
            tables: by_table
                .into_iter()
                .map(|(name, columns)| TableDef { name, columns })
                .collect(),
        })
    }
}
