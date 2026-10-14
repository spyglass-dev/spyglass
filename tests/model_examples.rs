//! Example queries ride on `/meta`, and the model refuses one that names a
//! member it does not declare — an example that drifted from the model would
//! hand an agent a broken query as a vetted one.
use spyglass::model::Model;

const YAML: &str = r#"
cubes:
  Orders:
    sql_table: orders
    measures:
      count: { type: count }
    dimensions:
      status: { type: string, sql: status }
    examples:
      - id: orders_by_status
        asks: ["orders by status", "how many orders in each status"]
        query: { measures: [Orders.count], dimensions: [Orders.status] }
"#;

#[test]
fn examples_reach_the_catalog() {
    let model: Model = serde_yaml::from_str(YAML).expect("parses");
    assert!(model.validate().is_ok(), "{:?}", model.validate());
    let meta = serde_json::to_value(model.metadata()).expect("serializes");
    let ex = &meta["cubes"][0]["examples"][0];
    assert_eq!(ex["id"], "orders_by_status");
    assert_eq!(ex["query"]["dimensions"][0], "Orders.status");
}

#[test]
fn an_example_naming_an_unknown_member_fails_validation() {
    let bad = YAML.replace("Orders.status]", "Orders.region]");
    let model: Model = serde_yaml::from_str(&bad).expect("parses");
    let problems = model.validate().expect_err("must fail");
    assert!(problems.iter().any(|p| p.contains("unknown member Orders.region")), "{problems:?}");
}
