//! Gap-fill and comparison-window tests — pure, no database. The merge logic
//! is unit-tested in `src/compare.rs` and the window shifting in
//! `src/dates.rs`; these lock the compiler contract: the generate_series
//! wrap, the solo-time-grouping validation both features share, and the
//! filter-only semantics of a granularity-less time dimension.

use spyglass::compiler::CompileError;
use spyglass::context::SecurityContext;
use spyglass::query::{Compare, DateRange, Granularity, Query, TimeDimension};

fn model() -> spyglass::model::Model {
    spyglass::loader::parse_str(
        r#"
cubes:
  Events:
    sql_table: events
    dimensions:
      kind: { type: string, sql: kind }
      created_at: { type: time, sql: created_at }
    measures:
      count: { type: count }
"#,
        "t.yml",
    )
    .unwrap()
}

fn ctx() -> SecurityContext {
    SecurityContext::default().allow_unscoped()
}

fn td(granularity: Option<Granularity>, fill_gaps: bool, compare: Option<Compare>) -> TimeDimension {
    TimeDimension {
        dimension: "Events.created_at".into(),
        granularity,
        date_range: Some(DateRange::Absolute(["2026-08-01".into(), "2026-09-01".into()])),
        compare,
        fill_gaps,
    }
}

#[test]
fn fill_gaps_wraps_the_aggregate_in_a_generate_series_join() {
    let query = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![td(Some(Granularity::Day), true, None)],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &ctx()).expect("compiles");
    let expected = "select gs.bucket::text as \"Events.created_at\", coalesce(q.\"Events.count\", 0) as \"Events.count\"\n\
from generate_series(date_trunc('day', $1::timestamptz), $2::timestamptz - interval '1 day', interval '1 day') as gs(bucket)\n\
left join (\n\
select date_trunc('day', created_at)::text as \"Events.created_at\", count(*) as \"Events.count\"\n\
from events as \"Events\"\n\
where created_at >= $1::timestamptz and created_at < $2::timestamptz\n\
group by date_trunc('day', created_at)::text\n\
) as q on q.\"Events.created_at\" = gs.bucket::text\n\
order by gs.bucket";
    assert_eq!(c.sql, expected);
    // The series reuses the window's own bind parameters — still just two.
    assert_eq!(c.params.len(), 2);
}

#[test]
fn quarter_steps_use_three_months_and_totals_count_buckets() {
    let query = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![td(Some(Granularity::Quarter), true, None)],
        include_total: true,
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &ctx()).expect("compiles");
    assert!(c.sql.contains("interval '3 months'"), "sql: {}", c.sql);
    // The __total window column sits on the OUTER select (counts buckets),
    // and appears exactly once.
    assert_eq!(c.sql.matches("count(*) over ()").count(), 1, "sql: {}", c.sql);
    let outer_first_line = c.sql.lines().next().unwrap();
    assert!(outer_first_line.contains("count(*) over ()"), "outer total: {outer_first_line}");
}

#[test]
fn fill_gaps_and_compare_share_the_solo_grouping_contract() {
    // Extra dimension → refused, for both features.
    for (fill, compare) in [(true, None), (false, Some(Compare::PreviousPeriod))] {
        let query = Query {
            measures: vec!["Events.count".into()],
            dimensions: vec!["Events.kind".into()],
            time_dimensions: vec![td(Some(Granularity::Day), fill, compare)],
            ..Default::default()
        };
        let err = spyglass::compile(&model(), &query, &ctx()).expect_err("must refuse");
        assert!(
            matches!(err, CompileError::BadFillGaps(_) | CompileError::BadCompare(_)),
            "got: {err}"
        );
    }
    // fill_gaps additionally needs a granularity (compare does not).
    let no_gran = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![td(None, true, None)],
        ..Default::default()
    };
    let err = spyglass::compile(&model(), &no_gran, &ctx()).expect_err("must refuse");
    assert!(format!("{err}").contains("granularity"), "got: {err}");

    let metric_compare = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![td(None, false, Some(Compare::PreviousPeriod))],
        ..Default::default()
    };
    spyglass::compile(&model(), &metric_compare, &ctx()).expect("metric compare compiles");
}

#[test]
fn granularity_less_time_dimension_is_filter_only() {
    // Cube semantics: without a granularity nothing is projected or grouped —
    // the range just filters. This is what makes a metric query with a date
    // window (and a comparison) coherent.
    let query = Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![td(None, false, None)],
        ..Default::default()
    };
    let c = spyglass::compile(&model(), &query, &ctx()).expect("compiles");
    let expected = "select count(*) as \"Events.count\"\n\
from events as \"Events\"\n\
where created_at >= $1::timestamptz and created_at < $2::timestamptz";
    assert_eq!(c.sql, expected);
    assert_eq!(c.columns.len(), 1, "only the measure is projected");
}
