//! Integration test against the **Pagila** dataset running in Docker. DB-gated:
//! it skips (passes as a no-op) unless `PAGILA_DATABASE_URL` is set, so the
//! default `cargo test` stays DB-free. To run it for real:
//!
//! ```bash
//! tests/pagila/setup.sh
//! PAGILA_DATABASE_URL=postgres://postgres:postgres@localhost:5438/pagila \
//!   cargo test --test pagila_integration -- --nocapture
//! ```
//!
//! It exercises the full runtime path against real data: load the committed
//! cubes, run a scoped query, and assert the mandatory `store_id` scope
//! isolates the two stores.

use spyglass::context::SecurityContext;
use spyglass::query::{Query, ScalarValue};
use std::collections::BTreeMap;

fn revenue_query(store: i64) -> (Query, SecurityContext) {
    let mut scope = BTreeMap::new();
    scope.insert("Payment.store_id".to_string(), ScalarValue::Int(store));
    (
        Query { measures: vec!["Payment.revenue".into()], ..Default::default() },
        SecurityContext { scope, ..Default::default() },
    )
}

#[tokio::test]
async fn pagila_scope_isolates_stores() {
    let url = match std::env::var("PAGILA_DATABASE_URL") {
        Ok(u) => u,
        Err(_) => {
            eprintln!("PAGILA_DATABASE_URL not set — skipping (see tests/pagila/setup.sh)");
            return;
        }
    };

    // The committed cubes load (also exercises the list/map loader + tenant flag).
    let model = spyglass::loader::load_dir("tests/pagila/cubes").expect("load pagila cubes");
    assert!(model.cube("Payment").is_some(), "Payment cube present");
    let meta = model.metadata();
    assert!(meta.cubes.iter().any(|c| c.name == "Payment"));

    let engine = spyglass::PostgresEngine::connect(&url)
        .await
        .expect("connect to pagila");

    let (q1, c1) = revenue_query(1);
    let (q2, c2) = revenue_query(2);
    let r1 = engine.run(&model, &q1, &c1).await.expect("store 1 query");
    let r2 = engine.run(&model, &q2, &c2).await.expect("store 2 query");

    let v1 = r1.rows[0]["Payment.revenue"].as_f64().expect("revenue 1");
    let v2 = r2.rows[0]["Payment.revenue"].as_f64().expect("revenue 2");

    assert!(v1 > 0.0 && v2 > 0.0, "both stores have revenue: {v1} / {v2}");
    assert_ne!(v1, v2, "scope must isolate stores: {v1} vs {v2}");
    // Sanity: the generated SQL carries the mandatory scope filter.
    assert!(r1.sql.unwrap().contains("store_id = $1"), "scope filter present");
    eprintln!("pagila ok — store1=${v1:.2} store2=${v2:.2}");
}
