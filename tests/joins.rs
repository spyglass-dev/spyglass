//! Join, label, and drill-metadata tests — pure, no database. Lock the
//! generated SQL for joined queries and the two security invariants:
//! fan-out rejection and tenant scope across the whole join tree.

use spyglass::compiler::CompileError;
use spyglass::context::SecurityContext;
use spyglass::model::Model;
use spyglass::query::{Filter, FilterOperator, Query, ScalarValue};

/// Orders —many_to_one→ Customers —many_to_one→ Regions, plus a declared
/// one_to_many from Customers back to Orders (documentation, never
/// traversable). Customers and Orders are tenant cubes; Regions is not.
fn shop_model() -> Model {
    let yaml = r#"
cubes:
  Orders:
    sql_table: orders
    joins:
      Customers: { relationship: many_to_one, sql: "${CUBE}.customer_id = ${Customers}.id" }
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      customer_id: { type: string, sql: customer_id, label: Customers.customer_name, drill: { entity: customer } }
      status: { type: string, sql: status }
      created_at: { type: time, sql: created_at }
    measures:
      count: { type: count, title: Orders }
      revenue: { type: sum, sql: amount }
    drill_members: [customer_id, status, created_at]
  Customers:
    sql_table: customers
    joins:
      Regions: { relationship: many_to_one, sql: "${CUBE}.region_id = ${Regions}.id" }
      Orders: { relationship: one_to_many, sql: "${CUBE}.id = ${Orders}.customer_id" }
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      id: { type: string, sql: id }
      customer_name: { type: string, sql: name }
    measures:
      count: { type: count }
  Regions:
    sql_table: regions
    dimensions:
      id: { type: string, sql: id }
      region_name: { type: string, sql: name }
    measures:
      count: { type: count }
"#;
    spyglass::loader::parse_str(yaml, "shop.yml").expect("model parses")
}

fn scoped() -> SecurityContext {
    SecurityContext::default()
        .with_scope("Orders.tenant_id", ScalarValue::String("t1".into()))
        .with_scope("Customers.tenant_id", ScalarValue::String("t1".into()))
}

#[test]
fn joined_dimension_compiles_to_left_join_with_qualified_columns() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Customers.customer_name".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    let expected = "select \"Customers\".name as \"Customers.customer_name\", count(*) as \"Orders.count\"\n\
from orders as \"Orders\"\n\
left join customers as \"Customers\" on \"Orders\".customer_id = \"Customers\".id\n\
where \"Customers\".tenant_id = $1 and \"Orders\".tenant_id = $2\n\
group by \"Customers\".name";
    assert_eq!(c.sql, expected);
    assert_eq!(
        c.params,
        vec![ScalarValue::String("t1".into()), ScalarValue::String("t1".into())]
    );
}

#[test]
fn multi_hop_join_emits_parents_first() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Regions.region_name".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    let joins: Vec<&str> = c.sql.lines().filter(|l| l.starts_with("left join")).collect();
    assert_eq!(
        joins,
        vec![
            "left join customers as \"Customers\" on \"Orders\".customer_id = \"Customers\".id",
            "left join regions as \"Regions\" on \"Customers\".region_id = \"Regions\".id",
        ]
    );
}

#[test]
fn one_to_many_traversal_is_fan_out_not_a_flag() {
    let model = shop_model();
    // Base = Customers (owns the measure); Orders is only reachable over the
    // declared one_to_many — refusing is the point: traversing it would
    // duplicate customer rows and inflate count().
    let query = Query {
        measures: vec!["Customers.count".into()],
        dimensions: vec!["Orders.status".into()],
        ..Default::default()
    };
    let err = spyglass::compile(&model, &query, &scoped()).expect_err("must refuse");
    match err {
        CompileError::FanOut { from, to } => {
            assert_eq!(from, "Customers");
            assert_eq!(to, "Orders");
        }
        other => panic!("expected FanOut, got: {other}"),
    }
}

#[test]
fn unreachable_cube_is_no_join_path() {
    let model = shop_model();
    // Base = Regions (measureless query starts at first dimension's cube);
    // Regions declares no joins at all.
    let query = Query {
        dimensions: vec!["Regions.region_name".into(), "Customers.customer_name".into()],
        ..Default::default()
    };
    let err = spyglass::compile(&model, &query, &SecurityContext::default().allow_unscoped())
        .expect_err("must refuse");
    match err {
        CompileError::NoJoinPath { from, to } => {
            assert_eq!(from, "Regions");
            assert_eq!(to, "Customers");
        }
        other => panic!("expected NoJoinPath, got: {other}"),
    }
}

#[test]
fn measures_spanning_cubes_stay_multiple_cubes() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into(), "Customers.count".into()],
        ..Default::default()
    };
    let err = spyglass::compile(&model, &query, &scoped()).expect_err("must refuse");
    assert!(matches!(err, CompileError::MultipleCubes(_)), "got: {err}");
}

/// THE security invariant: tenant scope applies to every cube in the join
/// tree. A joined tenant cube without its own scope entry fails closed —
/// this is the one place a join could quietly become a cross-tenant read.
#[test]
fn joined_tenant_cube_without_scope_fails_closed() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Customers.customer_name".into()],
        ..Default::default()
    };
    // Scope only the base cube — the joined Customers cube must still refuse.
    let base_only = SecurityContext::default()
        .with_scope("Orders.tenant_id", ScalarValue::String("t1".into()));
    let err = spyglass::compile(&model, &query, &base_only).expect_err("must refuse");
    match err {
        CompileError::MissingTenantScope { cube, dimension } => {
            assert_eq!(cube, "Customers");
            assert_eq!(dimension, "tenant_id");
        }
        other => panic!("expected MissingTenantScope, got: {other}"),
    }
    // With both scopes, both predicates land in the WHERE clause.
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    assert!(c.sql.contains("\"Customers\".tenant_id = $1"));
    assert!(c.sql.contains("\"Orders\".tenant_id = $2"));
}

#[test]
fn label_is_auto_projected_and_pulls_its_join() {
    let model = shop_model();
    // Nothing references Customers except customer_id's label.
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.customer_id".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    let expected = "select \"Orders\".customer_id as \"Orders.customer_id\", \"Customers\".name as \"Orders.customer_id__label\", count(*) as \"Orders.count\"\n\
from orders as \"Orders\"\n\
left join customers as \"Customers\" on \"Orders\".customer_id = \"Customers\".id\n\
where \"Customers\".tenant_id = $1 and \"Orders\".tenant_id = $2\n\
group by \"Orders\".customer_id, \"Customers\".name";
    assert_eq!(c.sql, expected);
    let label_col = c.columns.iter().find(|col| col.kind == "label").expect("label column");
    assert_eq!(label_col.key, "Orders.customer_id__label");
}

#[test]
fn sort_and_filter_still_act_on_the_id_not_the_label() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.customer_id".into()],
        filters: vec![Filter {
            member: "Orders.customer_id".into(),
            operator: FilterOperator::Equals,
            values: vec![ScalarValue::String("c42".into())],
        }],
        order: vec![spyglass::query::Order { member: "Orders.customer_id".into(), desc: false }],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    assert!(c.sql.contains("\"Orders\".customer_id = $1"), "filter on id: {}", c.sql);
    assert!(c.sql.contains("order by \"Orders.customer_id\" asc"), "order on id: {}", c.sql);
    assert!(!c.sql.contains("order by \"Orders.customer_id__label\""));
}

#[test]
fn filter_on_joined_dimension_compiles_into_where() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        filters: vec![Filter {
            member: "Customers.customer_name".into(),
            operator: FilterOperator::Contains,
            values: vec![ScalarValue::String("smith".into())],
        }],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    assert!(c.sql.contains("left join customers"), "join present: {}", c.sql);
    assert!(c.sql.contains("\"Customers\".name::text ilike $1"), "filter qualified: {}", c.sql);
}

#[test]
fn single_cube_queries_are_untouched_by_join_support() {
    let model = shop_model();
    let query = Query {
        measures: vec!["Orders.count".into()],
        dimensions: vec!["Orders.status".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model, &query, &scoped()).expect("compiles");
    // No joins → no alias qualification, exactly the pre-join SQL shape.
    let expected = "select status as \"Orders.status\", count(*) as \"Orders.count\"\n\
from orders as \"Orders\"\n\
where tenant_id = $1\n\
group by status";
    assert_eq!(c.sql, expected);
}

#[test]
fn drill_and_join_metadata_reach_the_catalog_without_sql() {
    let model = shop_model();
    let meta = model.metadata();
    let orders = meta.cubes.iter().find(|c| c.name == "Orders").expect("Orders meta");
    assert_eq!(orders.drill_members, vec!["customer_id", "status", "created_at"]);
    assert_eq!(orders.joins.len(), 1);
    assert_eq!(orders.joins[0].target, "Customers");
    let customer_id = orders
        .dimensions
        .iter()
        .find(|d| d.name == "customer_id")
        .expect("customer_id meta");
    assert_eq!(customer_id.label.as_deref(), Some("Customers.customer_name"));
    assert_eq!(customer_id.drill_entity.as_deref(), Some("customer"));
    // No SQL leaks anywhere in the serialized catalog.
    let json = serde_json::to_string(&meta).expect("serializes");
    assert!(!json.contains("customer_id = "), "join SQL must not leak: {json}");
    assert!(!json.contains("${CUBE}"), "join SQL must not leak: {json}");
}
