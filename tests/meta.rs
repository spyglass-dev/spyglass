//! Model metadata tests — pure, no database. Lock the UI-facing catalog
//! (`Cube.member` names, tenant flag) and that SQL never leaks into it.

use spyglass::loader::parse_str;

fn model() -> spyglass::model::Model {
    parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    title: Orders
    dimensions:
      workspace_id: { type: string, sql: workspace_id, tenant: true }
      status:       { type: string, sql: status }
    measures:
      count:   { type: count, title: Orders }
      revenue: { type: sum, sql: amount_cents, format: currency }
"#,
        "t.yml",
    )
    .unwrap()
}

#[test]
fn metadata_exposes_qualified_members() {
    let meta = model().metadata();
    assert_eq!(meta.cubes.len(), 1);
    let orders = &meta.cubes[0];
    assert_eq!(orders.name, "Orders");
    assert_eq!(orders.title.as_deref(), Some("Orders"));

    let revenue = orders.measures.iter().find(|m| m.name == "revenue").expect("revenue");
    assert_eq!(revenue.member, "Orders.revenue");
    assert_eq!(revenue.format.as_deref(), Some("currency"));

    let ws = orders.dimensions.iter().find(|d| d.name == "workspace_id").expect("ws");
    assert_eq!(ws.member, "Orders.workspace_id");
    assert!(ws.tenant);
    assert!(!orders.dimensions.iter().find(|d| d.name == "status").unwrap().tenant);
}

#[test]
fn metadata_does_not_leak_sql() {
    // The serialized catalog must not contain the cube/measure SQL.
    let meta = model().metadata();
    let json = serde_json::to_string(&meta).unwrap();
    assert!(!json.contains("amount_cents"), "SQL leaked into metadata: {json}");
    assert!(!json.contains("sql_table"), "table leaked into metadata: {json}");
}
