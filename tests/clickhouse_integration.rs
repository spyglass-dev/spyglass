#![cfg(feature = "clickhouse")]

//! Integration test against a real ClickHouse server. DB-gated: it skips
//! (passes as a no-op) unless `CLICKHOUSE_TEST_URL` is set, so
//! `cargo test --features clickhouse` stays DB-free. To run it for real:
//!
//! ```bash
//! docker run -d -p 8123:8123 clickhouse/clickhouse-server:24.8-alpine
//! CLICKHOUSE_TEST_URL=http://localhost:8123 \
//!   cargo test --features clickhouse --test clickhouse_integration -- --nocapture
//! ```
//!
//! It holds the same scope-isolation property tests/pagila_integration.rs
//! holds for Postgres: the mandatory tenant scope isolates workspaces end to
//! end, over real SQL against real data.

use spyglass::context::SecurityContext;
use spyglass::model::{Cube, Dimension, DimensionType, Measure, MeasureType, Model};
use spyglass::query::{DateRange, Granularity, Query, ScalarValue, TimeDimension};
use spyglass::ClickHouseEngine;
use std::collections::BTreeMap;

fn model(table: &str) -> Model {
    let mut dimensions = BTreeMap::new();
    dimensions.insert(
        "workspace_id".to_string(),
        Dimension {
            dimension_type: DimensionType::String,
            sql: Some("workspace_id".into()),
            tenant: true,
            ..Default::default()
        },
    );
    dimensions.insert(
        "event_type".to_string(),
        Dimension {
            dimension_type: DimensionType::String,
            sql: Some("event_type".into()),
            ..Default::default()
        },
    );
    dimensions.insert(
        "occurred_at".to_string(),
        Dimension {
            dimension_type: DimensionType::Time,
            sql: Some("occurred_at".into()),
            ..Default::default()
        },
    );

    let mut measures = BTreeMap::new();
    measures.insert(
        "count".to_string(),
        Measure {
            measure_type: MeasureType::Count,
            ..Default::default()
        },
    );
    measures.insert(
        "people".to_string(),
        Measure {
            measure_type: MeasureType::CountDistinct,
            sql: Some("contact_id".into()),
            ..Default::default()
        },
    );

    let cube = Cube {
        name: "Events".into(),
        sql_table: Some(table.into()),
        measures,
        dimensions,
        ..Default::default()
    };
    let mut cubes = BTreeMap::new();
    cubes.insert("Events".into(), cube);
    Model { cubes }
}

fn scoped(workspace: &str) -> SecurityContext {
    SecurityContext::default()
        .with_scope("Events.workspace_id", ScalarValue::String(workspace.into()))
}

/// Fixture DDL/DML goes straight over HTTP — the engine under test only ever
/// SELECTs, and keeping it that way is the point.
async fn execute(url: &str, sql: &str) {
    let response = reqwest::Client::new()
        .post(url)
        .body(sql.to_string())
        .send()
        .await
        .expect("clickhouse reachable");
    let status = response.status();
    assert!(
        status.is_success(),
        "fixture statement failed ({status}): {}",
        response.text().await.unwrap_or_default()
    );
}

#[tokio::test]
async fn scope_isolates_workspaces_end_to_end() {
    let url = match std::env::var("CLICKHOUSE_TEST_URL") {
        Ok(u) => u,
        Err(_) => {
            eprintln!(
                "CLICKHOUSE_TEST_URL not set — skipping (docker run -d -p 8123:8123 \
                 clickhouse/clickhouse-server:24.8-alpine)"
            );
            return;
        }
    };

    // A per-run table name keeps concurrent/aborted runs from colliding.
    let table = format!(
        "spyglass_it_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis()
    );
    execute(
        &url,
        &format!(
            "create table {table} (\
               workspace_id String, \
               contact_id String, \
               event_type String, \
               occurred_at DateTime64(3)\
             ) engine = MergeTree order by (workspace_id, occurred_at)"
        ),
    )
    .await;
    execute(
        &url,
        &format!(
            "insert into {table} values \
             ('w1','c1','opened','2026-08-03 10:00:00'), \
             ('w1','c1','opened','2026-08-03 11:00:00'), \
             ('w1','c2','clicked','2026-08-10 09:30:00'), \
             ('w2','c9','clicked','2026-08-10 12:00:00')"
        ),
    )
    .await;

    let model = model(&table);
    let engine = ClickHouseEngine::new(&url);

    // Scope isolation: the same count query sees only its own workspace.
    let count_query = Query {
        measures: vec!["Events.count".into()],
        ..Default::default()
    };
    let r1 = engine
        .run(&model, &count_query, &scoped("w1"))
        .await
        .expect("w1 query");
    let r2 = engine
        .run(&model, &count_query, &scoped("w2"))
        .await
        .expect("w2 query");
    assert_eq!(r1.rows[0]["Events.count"].as_i64(), Some(3), "w1 sees 3");
    assert_eq!(r2.rows[0]["Events.count"].as_i64(), Some(1), "w2 sees 1");
    // Sanity: the generated SQL carries the scope as a server-side parameter.
    assert!(
        r1.sql
            .as_deref()
            .unwrap()
            .contains("workspace_id = {p1:String}"),
        "scope filter present"
    );

    // Weekly buckets + count distinct: two opens by one contact are one person.
    let weekly = Query {
        measures: vec!["Events.people".into()],
        dimensions: vec!["Events.event_type".into()],
        time_dimensions: vec![TimeDimension {
            dimension: "Events.occurred_at".into(),
            granularity: Some(Granularity::Week),
            date_range: Some(DateRange::Absolute([
                "2026-08-01T00:00:00Z".into(),
                "2026-09-01T00:00:00Z".into(),
            ])),
            ..Default::default()
        }],
        ..Default::default()
    };
    let rw = engine
        .run(&model, &weekly, &scoped("w1"))
        .await
        .expect("weekly query");
    let opened = rw
        .rows
        .iter()
        .find(|r| r["Events.event_type"] == "opened")
        .expect("an opened row");
    assert_eq!(
        opened["Events.people"].as_i64(),
        Some(1),
        "two opens by one contact are one person"
    );

    // Pagination: the __total window column becomes `total`, never a column.
    let paged = Query {
        measures: vec!["Events.count".into()],
        dimensions: vec!["Events.event_type".into()],
        include_total: true,
        limit: Some(1),
        ..Default::default()
    };
    let rp = engine
        .run(&model, &paged, &scoped("w1"))
        .await
        .expect("paged query");
    assert_eq!(rp.rows.len(), 1, "one page row");
    assert_eq!(rp.total, Some(2), "two groups in total");
    assert!(rp.has_more, "a second page exists");
    assert!(
        !rp.rows[0].contains_key("__total"),
        "the total column is stripped from rows"
    );

    execute(&url, &format!("drop table {table}")).await;
    eprintln!("clickhouse ok — scope isolated, distinct counted, total stripped");
}
