//! Curated-catalog tests: the five curation fields flow into `/meta`,
//! `hidden` members are omitted (but stay queryable), and `Model::validate`
//! catches dangling cross-references at load time instead of query time.

use spyglass::context::SecurityContext;
use spyglass::loader::parse_str;
use spyglass::model::Model;
use spyglass::query::Query;

fn model() -> Model {
    parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    dimensions:
      status: { type: string, sql: status, description: Fulfilment state., featured: true, filterable: true }
      internal_batch: { type: string, sql: batch_no, hidden: true }
    measures:
      count: { type: count, title: Orders, description: Number of orders., featured: true, unit: orders }
      internal_checksum: { type: sum, sql: checksum, hidden: true }
"#,
        "t.yml",
    )
    .unwrap()
}

#[test]
fn curated_fields_flow_into_meta() {
    let meta = model().metadata();
    let orders = &meta.cubes[0];
    let count = orders.measures.iter().find(|m| m.name == "count").expect("count");
    assert_eq!(count.description.as_deref(), Some("Number of orders."));
    assert!(count.featured);
    assert_eq!(count.unit.as_deref(), Some("orders"));
    let status = orders.dimensions.iter().find(|d| d.name == "status").expect("status");
    assert_eq!(status.description.as_deref(), Some("Fulfilment state."));
    assert!(status.featured);
    assert!(status.filterable);
}

#[test]
fn hidden_members_are_omitted_from_meta_but_stay_queryable() {
    let m = model();
    let meta = m.metadata();
    let orders = &meta.cubes[0];
    assert!(
        !orders.measures.iter().any(|x| x.name == "internal_checksum"),
        "hidden measure must not appear in the catalog"
    );
    assert!(
        !orders.dimensions.iter().any(|x| x.name == "internal_batch"),
        "hidden dimension must not appear in the catalog"
    );
    // Hidden curates discovery, not access: the member still compiles.
    let query = Query {
        measures: vec!["Orders.internal_checksum".into()],
        dimensions: vec!["Orders.internal_batch".into()],
        ..Default::default()
    };
    spyglass::compile(&m, &query, &SecurityContext::default().allow_unscoped())
        .expect("hidden members remain queryable by name");
}

#[test]
fn validate_accepts_a_well_formed_model() {
    let m = parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    joins:
      Customers: { relationship: many_to_one, sql: "${CUBE}.customer_id = ${Customers}.id" }
    dimensions:
      customer_id: { type: string, sql: customer_id, label: Customers.name }
      status: { type: string, sql: status }
    measures:
      count: { type: count, drill_members: [status] }
    drill_members: [status, customer_id]
  Customers:
    sql_table: customers
    dimensions:
      id: { type: string, sql: id }
      name: { type: string, sql: name }
    measures:
      count: { type: count }
"#,
        "ok.yml",
    )
    .unwrap();
    m.validate().expect("valid model passes");
}

#[test]
fn validate_reports_every_dangling_reference() {
    let m = parse_str(
        r#"
cubes:
  Orders:
    sql_table: orders
    joins:
      Ghost: { relationship: many_to_one, sql: "${CUBE}.x = ${Ghost}.x" }
    dimensions:
      customer_id: { type: string, sql: customer_id, label: Customers.missing_name }
      status: { type: string, sql: status }
    measures:
      count: { type: count, drill_members: [customer_id] }
    drill_members: [status, not_a_dimension]
"#,
        "bad.yml",
    )
    .unwrap();
    let problems = m.validate().expect_err("invalid model must fail");
    let text = problems.join("\n");
    assert!(text.contains("join target 'Ghost'"), "missing join problem: {text}");
    assert!(text.contains("Customers.missing_name"), "missing label problem: {text}");
    assert!(text.contains("'not_a_dimension'"), "missing drill-member problem: {text}");
    // count's drill_members: [customer_id] widens the cube's [status, not_a_dimension].
    assert!(
        text.contains("never widen"),
        "missing measure-widening problem: {text}"
    );
    assert_eq!(problems.len(), 4, "every problem reported once: {text}");
}

#[test]
fn load_dir_validates_the_merged_model() {
    let dir = std::env::temp_dir().join(format!("spyglass-curation-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Two files: Orders joins Customers — valid only once BOTH are merged.
    std::fs::write(
        dir.join("a_orders.yml"),
        r#"
cubes:
  Orders:
    sql_table: orders
    joins:
      Customers: { relationship: many_to_one, sql: "${CUBE}.customer_id = ${Customers}.id" }
    dimensions:
      customer_id: { type: string, sql: customer_id }
    measures:
      count: { type: count }
"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("b_customers.yml"),
        r#"
cubes:
  Customers:
    sql_table: customers
    dimensions:
      id: { type: string, sql: id }
    measures:
      count: { type: count }
"#,
    )
    .unwrap();
    spyglass::loader::load_dir(&dir).expect("cross-file references validate after merge");

    // Remove the Customers file: the same Orders cube now fails to load.
    std::fs::remove_file(dir.join("b_customers.yml")).unwrap();
    let err = spyglass::loader::load_dir(&dir).expect_err("dangling join must fail load");
    assert!(format!("{err}").contains("join target 'Customers'"), "got: {err}");
    std::fs::remove_dir_all(&dir).ok();
}
