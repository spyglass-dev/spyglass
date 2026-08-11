//! Compiler tests — pure, no database. Lock the generated SQL + bound params
//! and the mandatory scope injection.

use spyglass::context::SecurityContext;
use spyglass::model::{Cube, Dimension, DimensionType, Measure, MeasureType, Model};
use spyglass::query::{Filter, FilterOperator, Order, Query, ScalarValue};
use std::collections::BTreeMap;

fn submissions_model() -> Model {
    let mut dimensions = BTreeMap::new();
    dimensions.insert(
        "status".to_string(),
        Dimension {
            dimension_type: DimensionType::String,
            sql: Some("status".into()),
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
        "created_at".to_string(),
        Dimension {
            dimension_type: DimensionType::Time,
            sql: Some("created_at".into()),
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
        "avg_score".to_string(),
        Measure {
            measure_type: MeasureType::Avg,
            sql: Some("score_pct".into()),
            format: Some("percent".into()),
            ..Default::default()
        },
    );

    let cube = Cube {
        name: "Submissions".into(),
        sql_table: Some("activity_submissions".into()),
        measures,
        dimensions,
        ..Default::default()
    };
    let mut cubes = BTreeMap::new();
    cubes.insert("Submissions".into(), cube);
    Model { cubes }
}

#[test]
fn compiles_group_by_with_scope() {
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into(), "Submissions.avg_score".into()],
        dimensions: vec!["Submissions.status".into()],
        filters: vec![Filter {
            member: "Submissions.status".into(),
            operator: FilterOperator::Equals,
            values: vec![ScalarValue::String("graded".into())],
        }],
        limit: Some(100),
        ..Default::default()
    };
    let ctx = SecurityContext::default()
        .with_scope("Submissions.workspace_id", ScalarValue::String("w1".into()));

    let c = spyglass::compile(&model, &query, &ctx).expect("compiles");

    let expected = "select status as \"Submissions.status\", count(*) as \"Submissions.count\", avg(score_pct)::float8 as \"Submissions.avg_score\"\n\
from activity_submissions as \"Submissions\"\n\
where status = $1 and workspace_id = $2\n\
group by status\n\
limit 100";
    assert_eq!(c.sql, expected);
    assert_eq!(
        c.params,
        vec![
            ScalarValue::String("graded".into()),
            ScalarValue::String("w1".into())
        ]
    );
    assert_eq!(c.columns.len(), 3);
}

#[test]
fn rejects_unscoped_tenant_cube() {
    // Fail closed: a cube with a tenant dimension refuses to compile without a
    // scope value for it — no silent cross-tenant read.
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        ..Default::default()
    };
    let err = spyglass::compile(&model, &query, &SecurityContext::default()).unwrap_err();
    match err {
        spyglass::CompileError::MissingTenantScope { cube, dimension } => {
            assert_eq!(cube, "Submissions");
            assert_eq!(dimension, "workspace_id");
        }
        other => panic!("expected MissingTenantScope, got {other:?}"),
    }
}

#[test]
fn allow_unscoped_bypasses_tenant_requirement() {
    // The explicit admin/offline opt-in lets a tenant cube compile unscoped.
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        ..Default::default()
    };
    let ctx = SecurityContext::default().allow_unscoped();
    let c = spyglass::compile(&model, &query, &ctx).expect("compiles unscoped");
    assert!(
        !c.sql.contains("where"),
        "should have no scope filter: {}",
        c.sql
    );
    assert!(c.params.is_empty());
}

#[test]
fn scope_is_always_injected_even_with_no_filters() {
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        ..Default::default()
    };
    let ctx = SecurityContext::default()
        .with_scope("Submissions.workspace_id", ScalarValue::String("w9".into()));
    let c = spyglass::compile(&model, &query, &ctx).expect("compiles");
    assert!(
        c.sql.contains("where workspace_id = $1"),
        "sql was: {}",
        c.sql
    );
    assert_eq!(c.params, vec![ScalarValue::String("w9".into())]);
}

#[test]
fn time_dimension_truncates_and_ranges() {
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        time_dimensions: vec![spyglass::TimeDimension {
            dimension: "Submissions.created_at".into(),
            granularity: Some(spyglass::Granularity::Day),
            date_range: Some(spyglass::query::DateRange::Absolute([
                "2026-01-01".into(),
                "2026-02-01".into(),
            ])),
            ..Default::default()
        }],
        order: vec![Order {
            member: "Submissions.created_at".into(),
            desc: false,
        }],
        ..Default::default()
    };
    // Not exercising scope here — read across tenants explicitly.
    let ctx = SecurityContext::default().allow_unscoped();
    let c = spyglass::compile(&model, &query, &ctx).expect("compiles");
    assert!(
        c.sql
            .contains("date_trunc('day', created_at)::text as \"Submissions.created_at\""),
        "{}",
        c.sql
    );
    assert!(c.sql.contains("created_at >= $1"), "{}", c.sql);
    assert!(c.sql.contains("created_at < $2"), "{}", c.sql);
    assert!(
        c.sql.contains("order by \"Submissions.created_at\" asc"),
        "{}",
        c.sql
    );
}

#[test]
fn filter_on_measure_routes_to_having() {
    // Formerly a rejection (CompileError::MeasureFilter); measure filters now
    // compile into HAVING against the aggregate expression, which is what
    // makes "top/worst/only-if" questions buildable. The full HAVING contract
    // is locked in tests/query_shapes.rs.
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        filters: vec![Filter {
            member: "Submissions.count".into(),
            operator: FilterOperator::Gt,
            values: vec![ScalarValue::Int(5)],
        }],
        ..Default::default()
    };
    let ctx = SecurityContext::default()
        .with_scope("Submissions.workspace_id", ScalarValue::String("w1".into()));
    let c = spyglass::compile(&model, &query, &ctx).expect("compiles");
    assert!(c.sql.contains("\nhaving count(*) > $2"), "sql: {}", c.sql);
    assert!(
        !c.sql.contains("where count"),
        "aggregate must not reach WHERE: {}",
        c.sql
    );
}

#[test]
fn in_filter_expands_placeholders() {
    let model = submissions_model();
    let query = Query {
        measures: vec!["Submissions.count".into()],
        dimensions: vec!["Submissions.status".into()],
        filters: vec![Filter {
            member: "Submissions.status".into(),
            operator: FilterOperator::In,
            values: vec![
                ScalarValue::String("graded".into()),
                ScalarValue::String("submitted".into()),
            ],
        }],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &SecurityContext::default().allow_unscoped())
        .expect("compiles");
    assert!(c.sql.contains("status in ($1, $2)"), "{}", c.sql);
    assert_eq!(c.params.len(), 2);
}

#[test]
fn parses_single_cube_yaml() {
    let yaml = r#"
name: Submissions
sql_table: activity_submissions
measures:
  count:
    type: count
dimensions:
  status:
    type: string
    sql: status
"#;
    let model = spyglass::loader::parse_str(yaml, "test.yml").expect("parses");
    assert!(model.cube("Submissions").is_some());
    assert_eq!(model.cubes.len(), 1);
}

#[test]
fn cubes_map_backfills_name_from_key() {
    // Under a `cubes:` map, each cube omits `name:` — the loader fills it from
    // the map key (this is the documented format used by examples/ and docs/).
    let yaml = r#"
cubes:
  Orders:
    sql_table: orders
    measures:
      count:
        type: count
  Events:
    sql_table: events
    dimensions:
      type:
        type: string
"#;
    let model = spyglass::loader::parse_str(yaml, "test.yml").expect("parses");
    assert_eq!(model.cubes.len(), 2);
    assert_eq!(model.cube("Orders").expect("Orders").name, "Orders");
    assert_eq!(model.cube("Events").expect("Events").name, "Events");
}

#[test]
fn casts_placeholders_to_column_types() {
    // The engine binds every param as text, so the compiler must cast each
    // placeholder to the column's type — `$n::numeric` / `$n::timestamptz` /
    // `$n::boolean` — and leave string columns bare. This is the fix that lets
    // an int4 `store_id` / a timestamp / a boolean column be filtered at all
    // (otherwise tokio-postgres errors with "error serializing parameter").
    let yaml = r#"
cubes:
  Sales:
    sql_table: sales
    dimensions:
      store_id: { type: number,  sql: store_id, tenant: true }
      active:   { type: boolean, sql: active }
      region:   { type: string,  sql: region }
      sold_at:  { type: time,    sql: sold_at }
    measures:
      count: { type: count }
"#;
    let model = spyglass::loader::parse_str(yaml, "t.yml").unwrap();

    // number tenant scope → ::numeric
    let mut scope = BTreeMap::new();
    scope.insert("Sales.store_id".to_string(), ScalarValue::Int(2));
    let ctx = SecurityContext {
        scope,
        ..Default::default()
    };
    let q: Query =
        serde_json::from_value(serde_json::json!({ "measures": ["Sales.count"] })).unwrap();
    let c = spyglass::compile(&model, &q, &ctx).unwrap();
    assert!(c.sql.contains("store_id = $1::numeric"), "{}", c.sql);

    // boolean filter → ::boolean ; string filter → bare ; time range → ::timestamptz
    let q2: Query = serde_json::from_value(serde_json::json!({
        "measures": ["Sales.count"],
        "filters": [
            { "member": "Sales.active", "operator": "equals", "values": [true] },
            { "member": "Sales.region", "operator": "equals", "values": ["west"] }
        ],
        "timeDimensions": [{ "dimension": "Sales.sold_at", "dateRange": ["2026-01-01", "2026-02-01"] }]
    }))
    .unwrap();
    let c2 = spyglass::compile(&model, &q2, &SecurityContext::default().allow_unscoped()).unwrap();
    assert!(c2.sql.contains("active = $1::boolean"), "{}", c2.sql);
    assert!(
        c2.sql.contains("region = $2") && !c2.sql.contains("region = $2::"),
        "{}",
        c2.sql
    );
    assert!(c2.sql.contains("sold_at >= $3::timestamptz"), "{}", c2.sql);
    assert!(c2.sql.contains("sold_at < $4::timestamptz"), "{}", c2.sql);
}

#[test]
fn scope_is_per_cube() {
    // A model-wide scope keyed by Cube.member must NOT make a single-cube query
    // "span multiple cubes", and only the queried cube's scope entry applies.
    let yaml = r#"
cubes:
  Orders:
    sql_table: orders
    dimensions:
      workspace_id: { type: string, sql: workspace_id, tenant: true }
    measures:
      count: { type: count }
  Events:
    sql_table: events
    dimensions:
      workspace_id: { type: string, sql: workspace_id, tenant: true }
    measures:
      count: { type: count }
"#;
    let model = spyglass::loader::parse_str(yaml, "test.yml").expect("parses");
    let mut scope = BTreeMap::new();
    scope.insert(
        "Orders.workspace_id".to_string(),
        ScalarValue::String("w1".into()),
    );
    scope.insert(
        "Events.workspace_id".to_string(),
        ScalarValue::String("w1".into()),
    );
    let ctx = SecurityContext {
        scope,
        ..Default::default()
    };
    let query: Query = serde_json::from_value(serde_json::json!({
        "measures": ["Orders.count"]
    }))
    .unwrap();
    let c = spyglass::compile(&model, &query, &ctx).expect("compiles to one cube");
    assert!(c.sql.contains("from orders"), "{}", c.sql);
    // Exactly one scope param applied (Orders'), not both cubes'.
    assert_eq!(
        c.params.len(),
        1,
        "only this cube's scope applies: {}",
        c.sql
    );
}

#[test]
fn accepts_canonical_cube_list_form() {
    // Cube's native YAML uses sequences with `name:` for cubes/dimensions/
    // measures — the loader normalizes that to the map-form (what distri-
    // generated cubes look like).
    let yaml = r#"
cubes:
  - name: Orders
    sql_table: orders
    dimensions:
      - name: workspace_id
        sql: workspace_id
        type: string
        tenant: true
      - name: status
        sql: status
        type: string
    measures:
      - name: count
        type: count
      - name: revenue
        type: sum
        sql: amount_cents
"#;
    let model = spyglass::loader::parse_str(yaml, "test.yml").expect("parses");
    let orders = model.cube("Orders").expect("Orders");
    assert_eq!(orders.name, "Orders");
    assert_eq!(orders.measures.len(), 2);
    assert!(orders.dimensions.get("workspace_id").expect("ws").tenant);
}
