//! `/values` compiler tests — pure, no database. Lock the security posture:
//! the `filterable: true` allowlist, tenant scope enforcement (including the
//! label's joined cube), and search binding as a parameter.

use spyglass::compiler::{compile_values, CompileError};
use spyglass::context::SecurityContext;
use spyglass::query::ScalarValue;

fn model() -> spyglass::model::Model {
    spyglass::loader::parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    joins:
      Customers: { relationship: many_to_one, sql: "${CUBE}.customer_id = ${Customers}.id" }
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      status: { type: string, sql: status, filterable: true }
      customer_id: { type: string, sql: customer_id, filterable: true, label: Customers.customer_name }
      internal_ref: { type: string, sql: internal_ref }
  Customers:
    sql_table: customers
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      id: { type: string, sql: id }
      customer_name: { type: string, sql: name }
"#,
        "t.yml",
    )
    .unwrap()
}

fn scoped() -> SecurityContext {
    SecurityContext::default()
        .with_scope("Orders.tenant_id", ScalarValue::String("t1".into()))
        .with_scope("Customers.tenant_id", ScalarValue::String("t1".into()))
}

#[test]
fn values_query_is_scoped_grouped_and_count_ordered() {
    let c = compile_values(&model(), "Orders.status", None, None, &scoped()).expect("compiles");
    let expected = "select status as \"value\", count(*) as \"count\"\n\
from orders as \"Orders\"\n\
where tenant_id = $1\n\
group by status\n\
order by \"count\" desc, \"value\" asc\n\
limit 50";
    assert_eq!(c.sql, expected);
    assert_eq!(c.params, vec![ScalarValue::String("t1".into())]);
}

#[test]
fn labelled_dimension_joins_and_searches_on_the_label() {
    // Users type names, not UUIDs: search must match what they SEE.
    let c = compile_values(
        &model(),
        "Orders.customer_id",
        Some("smith"),
        Some(10),
        &scoped(),
    )
    .expect("compiles");
    assert!(
        c.sql.contains("left join customers"),
        "label join: {}",
        c.sql
    );
    assert!(
        c.sql.contains("\"Customers\".name as \"label\""),
        "label projected: {}",
        c.sql
    );
    assert!(
        c.sql.contains("\"Customers\".name::text ilike $1"),
        "search targets the label: {}",
        c.sql
    );
    assert_eq!(c.params[0], ScalarValue::String("%smith%".into()));
    assert!(c.sql.ends_with("limit 10"), "sql: {}", c.sql);
    // Both tenant cubes contribute scope predicates.
    assert!(
        c.sql.contains("\"Customers\".tenant_id = $2"),
        "sql: {}",
        c.sql
    );
    assert!(
        c.sql.contains("\"Orders\".tenant_id = $3"),
        "sql: {}",
        c.sql
    );
}

#[test]
fn non_filterable_dimensions_are_refused() {
    // The allowlist IS the security posture: /values never serves a dimension
    // the model didn't explicitly offer for filtering.
    let err = compile_values(&model(), "Orders.internal_ref", None, None, &scoped())
        .expect_err("must refuse");
    assert!(matches!(err, CompileError::NotFilterable(_)), "got: {err}");
    // tenant_id is not filterable either — scope columns are not facets.
    assert!(compile_values(&model(), "Orders.tenant_id", None, None, &scoped()).is_err());
}

#[test]
fn unscoped_tenant_cube_fails_closed() {
    let err = compile_values(
        &model(),
        "Orders.status",
        None,
        None,
        &SecurityContext::default(),
    )
    .expect_err("must refuse");
    assert!(
        matches!(err, CompileError::MissingTenantScope { .. }),
        "got: {err}"
    );
}

#[test]
fn limit_is_capped() {
    let c = compile_values(&model(), "Orders.status", None, Some(100_000), &scoped()).unwrap();
    assert!(c.sql.ends_with("limit 500"), "cap at 500: {}", c.sql);
}
