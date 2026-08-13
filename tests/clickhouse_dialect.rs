//! ClickHouse dialect tests — pure, no database. The semantics (join
//! planning, scope injection, the fail-closed tenant rule) are shared with
//! the Postgres dialect and locked by tests/compiler.rs; what these lock is
//! the syntax the dialect emits: {pn:String} parameters and the text
//! coercions that stand in for Postgres's ::type casts.

use spyglass::compiler::{compile_at_for, CompileError, Dialect};
use spyglass::context::SecurityContext;
use spyglass::model::{Cube, Dimension, DimensionType, Measure, MeasureType, Model};
use spyglass::query::{
    DateRange, Filter, FilterOperator, Granularity, Query, ScalarValue, TimeDimension,
};
use std::collections::BTreeMap;

const EPOCH: chrono::DateTime<chrono::Utc> = chrono::DateTime::UNIX_EPOCH;

fn events_model() -> Model {
    let mut dimensions = BTreeMap::new();
    dimensions.insert(
        "event_type".to_string(),
        Dimension {
            dimension_type: DimensionType::String,
            sql: Some("event_type".into()),
            ..Default::default()
        },
    );
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
        "occurred_at".to_string(),
        Dimension {
            dimension_type: DimensionType::Time,
            sql: Some("occurred_at".into()),
            ..Default::default()
        },
    );
    dimensions.insert(
        "score".to_string(),
        Dimension {
            dimension_type: DimensionType::Number,
            sql: Some("score".into()),
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
    measures.insert(
        "avg_score".to_string(),
        Measure {
            measure_type: MeasureType::Avg,
            sql: Some("score".into()),
            ..Default::default()
        },
    );

    let cube = Cube {
        name: "Events".into(),
        sql_table: Some("events".into()),
        measures,
        dimensions,
        ..Default::default()
    };
    let mut cubes = BTreeMap::new();
    cubes.insert("Events".into(), cube);
    Model { cubes }
}

fn scoped() -> SecurityContext {
    SecurityContext::default().with_scope("Events.workspace_id", ScalarValue::String("w1".into()))
}

#[test]
fn scope_binds_as_a_server_side_parameter_never_interpolated() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        ..Default::default()
    };
    let c =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).expect("compiles");
    assert!(
        c.sql.contains("workspace_id = {p1:String}"),
        "scope is a server-side parameter: {}",
        c.sql
    );
    assert!(
        !c.sql.contains("w1"),
        "the tenant value never appears in SQL: {}",
        c.sql
    );
    assert_eq!(c.params, vec![ScalarValue::String("w1".into())]);
}

#[test]
fn numeric_aggregates_coerce_with_tofloat64_not_a_cast() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.avg_score".into(), "Events.people".into()],
        ..Default::default()
    };
    let c =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).expect("compiles");
    assert!(
        c.sql.contains("toFloat64(avg(score))"),
        "avg coerces with toFloat64: {}",
        c.sql
    );
    assert!(
        c.sql.contains("count(distinct contact_id)"),
        "count distinct is shared syntax: {}",
        c.sql
    );
    assert!(
        !c.sql.contains("::float8"),
        "no postgres cast leaks into the clickhouse dialect: {}",
        c.sql
    );
}

#[test]
fn a_time_dimension_truncates_with_the_shared_date_trunc_and_tostring() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![TimeDimension {
            dimension: "Events.occurred_at".into(),
            granularity: Some(Granularity::Week),
            date_range: Some(DateRange::Absolute([
                "2026-08-01".into(),
                "2026-09-01".into(),
            ])),
            ..Default::default()
        }],
        ..Default::default()
    };
    let c =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).expect("compiles");
    assert!(
        c.sql.contains("toString(date_trunc('week', occurred_at))"),
        "buckets project as text: {}",
        c.sql
    );
    assert!(
        c.sql
            .contains("occurred_at >= parseDateTimeBestEffort({p1:String})"),
        "window lower bound coerces its parameter: {}",
        c.sql
    );
    assert!(
        c.sql
            .contains("occurred_at < parseDateTimeBestEffort({p2:String})"),
        "window upper bound coerces its parameter: {}",
        c.sql
    );
}

#[test]
fn a_number_filter_coerces_its_parameter() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        filters: vec![Filter {
            member: "Events.score".into(),
            operator: FilterOperator::Gte,
            values: vec![ScalarValue::Float(0.5)],
        }],
        ..Default::default()
    };
    let c =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).expect("compiles");
    assert!(
        c.sql.contains("score >= toFloat64({p1:String})"),
        "number parameters coerce in SQL: {}",
        c.sql
    );
}

#[test]
fn contains_stays_ilike_over_text() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        filters: vec![Filter {
            member: "Events.event_type".into(),
            operator: FilterOperator::Contains,
            values: vec![ScalarValue::String("click".into())],
        }],
        ..Default::default()
    };
    let c =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).expect("compiles");
    // User filters bind before the mandatory scope, so the pattern is p1.
    assert!(
        c.sql.contains("toString(event_type) ilike {p1:String}"),
        "contains matches over text: {}",
        c.sql
    );
    assert_eq!(
        c.params.first(),
        Some(&ScalarValue::String("%click%".into()))
    );
}

#[test]
fn fill_gaps_is_refused_rather_than_compiled_into_postgres_sql() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![TimeDimension {
            dimension: "Events.occurred_at".into(),
            granularity: Some(Granularity::Day),
            date_range: Some(DateRange::Absolute([
                "2026-08-01".into(),
                "2026-09-01".into(),
            ])),
            fill_gaps: true,
            ..Default::default()
        }],
        ..Default::default()
    };
    // The FanOut trade: a missing capability beats a wrong answer.
    let err = compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::ClickHouse).unwrap_err();
    assert!(
        matches!(err, CompileError::BadFillGaps(_)),
        "expected BadFillGaps, got {err:?}"
    );
}

#[test]
fn the_postgres_dialect_is_unchanged_by_the_seam() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        ..Default::default()
    };
    let via_default = spyglass::compile_at(&model, &query, &scoped(), EPOCH).expect("compiles");
    let via_dialect =
        compile_at_for(&model, &query, &scoped(), EPOCH, Dialect::Postgres).expect("compiles");
    assert_eq!(
        via_default.sql, via_dialect.sql,
        "the seam changes nothing for postgres"
    );
    assert!(
        via_default.sql.contains("workspace_id = $1"),
        "postgres keeps $n placeholders: {}",
        via_default.sql
    );
}

#[test]
fn the_tenant_rule_fails_closed_in_every_dialect() {
    let model = events_model();
    let query = Query {
        measures: vec!["Events.count".into()],
        ..Default::default()
    };
    let err = compile_at_for(
        &model,
        &query,
        &SecurityContext::default(),
        EPOCH,
        Dialect::ClickHouse,
    )
    .unwrap_err();
    assert!(
        matches!(err, CompileError::MissingTenantScope { .. }),
        "expected MissingTenantScope, got {err:?}"
    );
}
