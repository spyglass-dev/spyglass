//! Relative-date wiring tests — pure, no database. The grammar itself is
//! unit-tested in `src/dates.rs`; these lock the compiler contract: a doc
//! storing `"last 30 days"` resolves to a live window against an INJECTED
//! clock, `timezone` shifts the boundaries, and the clockless `compile()`
//! refuses relative ranges instead of guessing.

use spyglass::context::SecurityContext;
use spyglass::query::{DateRange, Query, ScalarValue, TimeDimension};

fn strs(v: &[&str]) -> Vec<ScalarValue> {
    v.iter().map(|s| ScalarValue::String(s.to_string())).collect()
}

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

fn q(range: DateRange, timezone: Option<&str>) -> Query {
    Query {
        measures: vec!["Events.count".into()],
        time_dimensions: vec![TimeDimension {
            dimension: "Events.created_at".into(),
            granularity: None,
            date_range: Some(range),
        }],
        timezone: timezone.map(str::to_string),
        ..Default::default()
    }
}

fn clock(s: &str) -> chrono::DateTime<chrono::Utc> {
    s.parse().expect("test clock parses")
}

#[test]
fn a_stored_relative_range_resolves_to_a_live_window_per_clock() {
    let ctx = SecurityContext::default().allow_unscoped();
    let query = q(DateRange::Relative("last 30 days".into()), None);

    let jan = spyglass::compile_at(&model(), &query, &ctx, clock("2026-01-15T12:00:00Z")).unwrap();
    let aug = spyglass::compile_at(&model(), &query, &ctx, clock("2026-08-09T12:00:00Z")).unwrap();

    // Same document, different clock → different bound window. The SQL shape
    // is identical; only the params move.
    assert_eq!(jan.sql, aug.sql);
    assert_eq!(jan.params, strs(&["2025-12-17T00:00:00+00:00", "2026-01-16T00:00:00+00:00"]));
    assert_eq!(aug.params, strs(&["2026-07-11T00:00:00+00:00", "2026-08-10T00:00:00+00:00"]));
}

#[test]
fn timezone_shifts_the_window_boundaries() {
    let ctx = SecurityContext::default().allow_unscoped();
    let now = clock("2026-08-09T01:00:00Z"); // Aug 8 evening in Los Angeles
    let la = spyglass::compile_at(
        &model(),
        &q(DateRange::Relative("today".into()), Some("America/Los_Angeles")),
        &ctx,
        now,
    )
    .unwrap();
    assert_eq!(la.params[0], ScalarValue::String("2026-08-08T07:00:00+00:00".into()));

    let err = spyglass::compile_at(
        &model(),
        &q(DateRange::Relative("today".into()), Some("Mars/Olympus")),
        &ctx,
        now,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("unknown timezone"), "got: {err}");
}

#[test]
fn absolute_ranges_compile_identically_with_and_without_a_clock() {
    let ctx = SecurityContext::default().allow_unscoped();
    let query = q(
        DateRange::Absolute(["2026-01-01".into(), "2026-02-01".into()]),
        None,
    );
    let without = spyglass::compile(&model(), &query, &ctx).unwrap();
    let with = spyglass::compile_at(&model(), &query, &ctx, clock("2026-08-09T00:00:00Z")).unwrap();
    assert_eq!(without.sql, with.sql);
    assert_eq!(without.params, with.params);
}

#[test]
fn clockless_compile_refuses_relative_ranges() {
    let ctx = SecurityContext::default().allow_unscoped();
    let err = spyglass::compile(&model(), &q(DateRange::Relative("ytd".into()), None), &ctx)
        .unwrap_err();
    assert!(
        matches!(err, spyglass::CompileError::RelativeDateNeedsClock(_)),
        "got: {err}"
    );
}

#[test]
fn bad_grammar_is_a_typed_error_with_accepted_forms() {
    let ctx = SecurityContext::default().allow_unscoped();
    let err = spyglass::compile_at(
        &model(),
        &q(DateRange::Relative("whenever".into()), None),
        &ctx,
        clock("2026-08-09T00:00:00Z"),
    )
    .unwrap_err();
    assert!(matches!(err, spyglass::CompileError::BadDateRange(_)), "got: {err}");
    assert!(format!("{err}").contains("accepted:"), "got: {err}");
}

#[test]
fn wire_json_accepts_both_range_forms() {
    let absolute: Query =
        serde_json::from_str(r#"{"measures":["Events.count"],"timeDimensions":[{"dimension":"Events.created_at","dateRange":["2026-01-01","2026-02-01"]}]}"#)
            .unwrap();
    assert!(matches!(
        absolute.time_dimensions[0].date_range,
        Some(DateRange::Absolute(_))
    ));
    let relative: Query =
        serde_json::from_str(r#"{"measures":["Events.count"],"timeDimensions":[{"dimension":"Events.created_at","dateRange":"last 30 days"}],"timezone":"Europe/London"}"#)
            .unwrap();
    assert!(matches!(
        relative.time_dimensions[0].date_range,
        Some(DateRange::Relative(_))
    ));
    assert_eq!(relative.timezone.as_deref(), Some("Europe/London"));
}
