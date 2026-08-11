//! Pagination, HAVING, and row-mode tests — pure, no database. Lock the
//! "done when" invariants: include_total adds exactly one window column and
//! does not alter grouping; a measure filter compiles into HAVING, never
//! WHERE; row mode projects exactly drill_members ∩ requested and refuses a
//! cube without them.

use spyglass::compiler::CompileError;
use spyglass::context::SecurityContext;
use spyglass::model::Model;
use spyglass::query::{Filter, FilterOperator, Query, QueryMode, ScalarValue};

fn model() -> Model {
    spyglass::loader::parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      status: { type: string, sql: status }
      customer_id: { type: string, sql: customer_id }
      created_at: { type: time, sql: created_at }
    measures:
      count: { type: count }
      revenue: { type: sum, sql: amount }
    drill_members: [status, customer_id, created_at]
  Totals:
    sql_table: totals
    dimensions:
      region: { type: string, sql: region }
    measures:
      count: { type: count }
"#,
        "t.yml",
    )
    .unwrap()
}

fn scoped() -> SecurityContext {
    SecurityContext::default().with_scope("Orders.tenant_id", ScalarValue::String("t1".into()))
}

#[test]
fn offset_and_limit_compile_into_sql() {
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.status".into()],
        limit: Some(25),
        offset: Some(50),
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    assert!(c.sql.ends_with("limit 25\noffset 50"), "sql: {}", c.sql);
}

#[test]
fn include_total_adds_exactly_one_window_column_and_leaves_grouping_alone() {
    let base = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.status".into()],
        ..Default::default()
    };
    let plain = spyglass::compile(&model(), &base, &scoped()).unwrap();
    let with_total = spyglass::compile(
        &model(),
        &Query {
            include_total: true,
            ..base
        },
        &scoped(),
    )
    .unwrap();

    assert_eq!(
        with_total.sql.matches("count(*) over ()").count(),
        1,
        "exactly one window column: {}",
        with_total.sql
    );
    // Same GROUP BY as the plain query — the total must not alter grouping.
    let group = |sql: &str| {
        sql.lines()
            .find(|l| l.starts_with("group by"))
            .map(str::to_string)
    };
    assert_eq!(group(&plain.sql), group(&with_total.sql));
    // The window column is the only projection difference.
    let total_col = with_total
        .columns
        .iter()
        .filter(|c| c.kind == "total")
        .count();
    assert_eq!(total_col, 1);
}

#[test]
fn measure_filter_compiles_into_having_never_where() {
    let query = Query {
        measures: vec!["Orders.revenue".into()],
        dimensions: vec!["Orders.customer_id".into()],
        filters: vec![
            Filter {
                member: "Orders.status".into(),
                operator: FilterOperator::Equals,
                values: vec![ScalarValue::String("paid".into())],
            },
            Filter {
                member: "Orders.revenue".into(),
                operator: FilterOperator::Gte,
                values: vec![ScalarValue::Int(1000)],
            },
        ],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    let where_line = c
        .sql
        .lines()
        .find(|l| l.starts_with("where"))
        .expect("where");
    let having_line = c
        .sql
        .lines()
        .find(|l| l.starts_with("having"))
        .expect("having");
    assert!(
        !where_line.contains("sum(amount)"),
        "aggregate leaked into WHERE: {where_line}"
    );
    assert!(
        having_line.contains("sum(amount)::float8 >= "),
        "having: {having_line}"
    );
    // HAVING params bind after WHERE + scope params.
    assert_eq!(
        c.params,
        vec![
            ScalarValue::String("paid".into()),
            ScalarValue::String("t1".into()),
            ScalarValue::Int(1000),
        ]
    );
}

#[test]
fn rows_mode_projects_requested_intersect_drill_members_without_grouping() {
    let query = Query {
        dimensions: vec![
            "Orders.status".into(),
            "Orders.tenant_id".into(), // requested but NOT in drill_members → dropped
        ],
        mode: QueryMode::Rows,
        limit: Some(10),
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    assert!(
        !c.sql.contains("group by"),
        "row mode must not group: {}",
        c.sql
    );
    let keys: Vec<&str> = c.columns.iter().map(|col| col.key.as_str()).collect();
    assert_eq!(
        keys,
        vec!["Orders.status"],
        "projection is requested ∩ drill_members"
    );
    // Scope still applies in row mode.
    assert!(
        c.sql.contains("tenant_id = $1"),
        "scope must still apply: {}",
        c.sql
    );
}

#[test]
fn rows_mode_with_no_requested_dimensions_projects_all_drill_members() {
    let query = Query {
        filters: vec![Filter {
            member: "Orders.customer_id".into(),
            operator: FilterOperator::Equals,
            values: vec![ScalarValue::String("c1".into())],
        }],
        mode: QueryMode::Rows,
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    let keys: Vec<&str> = c.columns.iter().map(|col| col.key.as_str()).collect();
    assert_eq!(
        keys,
        vec!["Orders.status", "Orders.customer_id", "Orders.created_at"],
        "the cube's published record shape, in declaration order"
    );
}

#[test]
fn rows_mode_refuses_a_cube_without_drill_members() {
    let query = Query {
        dimensions: vec!["Totals.region".into()],
        mode: QueryMode::Rows,
        ..Default::default()
    };
    let err = spyglass::compile(
        &model(),
        &query,
        &SecurityContext::default().allow_unscoped(),
    )
    .expect_err("must refuse");
    assert!(
        matches!(err, CompileError::NoDrillMembers(ref c) if c == "Totals"),
        "got: {err}"
    );
}

#[test]
fn rows_mode_refuses_measures_and_measure_filters() {
    let with_measure = Query {
        measures: vec!["Orders.count".into()],
        mode: QueryMode::Rows,
        ..Default::default()
    };
    let err = spyglass::compile(&model(), &with_measure, &scoped()).expect_err("must refuse");
    assert!(
        matches!(err, CompileError::RowsWithMeasures(_)),
        "got: {err}"
    );

    let with_measure_filter = Query {
        dimensions: vec!["Orders.status".into()],
        filters: vec![Filter {
            member: "Orders.revenue".into(),
            operator: FilterOperator::Gte,
            values: vec![ScalarValue::Int(1)],
        }],
        mode: QueryMode::Rows,
        ..Default::default()
    };
    let err =
        spyglass::compile(&model(), &with_measure_filter, &scoped()).expect_err("must refuse");
    assert!(matches!(err, CompileError::MeasureFilter(_)), "got: {err}");
}

#[test]
fn existing_aggregate_sql_is_unchanged_when_new_features_are_unused() {
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.status".into()],
        limit: Some(100),
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    let expected = "select status as \"Orders.status\", count(*) as \"Orders.count\"\n\
from orders as \"Orders\"\n\
where tenant_id = $1\n\
group by status\n\
limit 100";
    assert_eq!(c.sql, expected);
}
