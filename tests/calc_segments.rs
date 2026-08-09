//! Calculated-measure and segment tests — pure, no database. Lock the
//! interpolation contract: `${CUBE.measure}` resolves to the referenced
//! measure's COMPILED aggregate expression (recursively), only declared
//! same-cube measures interpolate, cycles are refused at load time, and
//! segments compile into WHERE with the cube's tenant scope still enforced.

use spyglass::compiler::CompileError;
use spyglass::context::SecurityContext;
use spyglass::query::{Query, ScalarValue};

fn model() -> spyglass::model::Model {
    spyglass::loader::parse_str(
        r#"
cubes:
  Items:
    sql_table: items
    dimensions:
      tenant_id: { type: string, sql: tenant_id, tenant: true }
      status: { type: string, sql: status }
    measures:
      count: { type: count }
      published: { type: sum, sql: "case when published_at is not null then 1 else 0 end" }
      publish_rate:
        type: number
        sql: "${CUBE.published} / nullif(${CUBE.count}, 0) * 100"
        format: percent
      publish_rate_pretty:
        type: number
        sql: "round(${Items.publish_rate})"
    segments:
      active: { sql: "${CUBE}.archived_at is null", description: Items not archived. }
"#,
        "t.yml",
    )
    .unwrap()
}

fn scoped() -> SecurityContext {
    SecurityContext::default().with_scope("Items.tenant_id", ScalarValue::String("t1".into()))
}

#[test]
fn calculated_measure_resolves_to_compiled_aggregates() {
    let query = Query {
        measures: vec!["Items.publish_rate".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    assert!(
        c.sql.contains(
            "(sum(case when published_at is not null then 1 else 0 end)::float8 / nullif(count(*), 0) * 100)::float8"
        ),
        "sql: {}",
        c.sql
    );
}

#[test]
fn interpolation_nests_and_having_works_on_calculated_measures() {
    let query = Query {
        measures: vec!["Items.publish_rate_pretty".into()],
        filters: vec![spyglass::Filter {
            member: "Items.publish_rate".into(),
            operator: spyglass::FilterOperator::Gte,
            values: vec![ScalarValue::Int(50)],
        }],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    // Nested: publish_rate_pretty -> publish_rate -> published/count.
    assert!(c.sql.contains("round((sum(case when"), "nested interpolation: {}", c.sql);
    // The measure filter routes to HAVING against the interpolated aggregate.
    assert!(c.sql.contains("\nhaving (sum(case when"), "having: {}", c.sql);
}

#[test]
fn only_declared_same_cube_measures_interpolate() {
    let m = spyglass::loader::parse_str(
        r#"
cubes:
  Items:
    sql_table: items
    measures:
      count: { type: count }
      bad: { type: number, sql: "${Other.count} + 1" }
"#,
        "t.yml",
    )
    .unwrap();
    let query = Query { measures: vec!["Items.bad".into()], ..Default::default() };
    let err = spyglass::compile(&m, &query, &SecurityContext::default().allow_unscoped())
        .expect_err("must refuse");
    assert!(matches!(err, CompileError::UnknownMember(_)), "got: {err}");
}

#[test]
fn cycles_and_unknown_refs_fail_load_time_validation() {
    let cyclic = spyglass::loader::parse_str(
        r#"
cubes:
  Items:
    sql_table: items
    measures:
      a: { type: number, sql: "${CUBE.b} + 1" }
      b: { type: number, sql: "${CUBE.a} + 1" }
"#,
        "t.yml",
    )
    .unwrap();
    let problems = cyclic.validate().expect_err("cycle must fail");
    assert!(problems.iter().any(|p| p.contains("cycle")), "problems: {problems:?}");

    let dangling = spyglass::loader::parse_str(
        r#"
cubes:
  Items:
    sql_table: items
    measures:
      rate: { type: number, sql: "${CUBE.missing} * 2" }
      wrong_type: { type: sum, sql: "${CUBE.rate}" }
"#,
        "t.yml",
    )
    .unwrap();
    let problems = dangling.validate().expect_err("dangling ref must fail");
    let text = problems.join("\n");
    assert!(text.contains("'missing' is not a measure"), "problems: {text}");
    // Interpolation in a non-number measure (aggregates can't nest) is flagged.
    assert!(text.contains("`number` measures"), "problems: {text}");
}

#[test]
fn segment_compiles_into_where_with_scope_still_applied() {
    let query = Query {
        measures: vec!["Items.count".into()],
        segments: vec!["Items.active".into()],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &scoped()).expect("compiles");
    let expected = "select count(*) as \"Items.count\"\n\
from items as \"Items\"\n\
where (\"Items\".archived_at is null) and tenant_id = $1";
    assert_eq!(c.sql, expected);
    assert_eq!(c.params, vec![ScalarValue::String("t1".into())]);
}

#[test]
fn unknown_segment_is_refused() {
    let query = Query {
        measures: vec!["Items.count".into()],
        segments: vec!["Items.ghost".into()],
        ..Default::default()
    };
    let err = spyglass::compile(&model(), &query, &scoped()).expect_err("must refuse");
    assert!(matches!(err, CompileError::UnknownMember(ref m) if m == "Items.ghost"), "got: {err}");
}

#[test]
fn segments_reach_the_catalog_without_sql() {
    let meta = model().metadata();
    let items = meta.cubes.iter().find(|c| c.name == "Items").expect("Items");
    assert_eq!(items.segments.len(), 1);
    assert_eq!(items.segments[0].member, "Items.active");
    assert_eq!(items.segments[0].description.as_deref(), Some("Items not archived."));
    let json = serde_json::to_string(&meta).unwrap();
    assert!(!json.contains("archived_at"), "segment SQL leaked: {json}");
    assert!(!json.contains("nullif"), "calculated SQL leaked: {json}");
}
