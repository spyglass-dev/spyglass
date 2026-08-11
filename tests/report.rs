//! Report resolver tests — pure, no database. Lock how bound widgets turn a
//! `QueryResult` into the data-bearing `WidgetSpec` JSON the UI renders.

use serde_json::json;
use spyglass::query::{Column, Filter, FilterOperator, Query, QueryResult, ScalarValue};
use spyglass::report::{resolve_widget, with_run_filters, BoundWidget, ChartHint};

fn result(columns: &[(&str, &str)], rows: Vec<serde_json::Value>) -> QueryResult {
    QueryResult {
        columns: columns
            .iter()
            .map(|(key, kind)| Column::new(*key, *kind))
            .collect(),
        rows: rows
            .into_iter()
            .map(|v| v.as_object().unwrap().clone())
            .collect(),
        total: None,
        has_more: false,
        truncated_at: None,
        sql: None,
    }
}

fn widget(kind: &str) -> BoundWidget {
    BoundWidget {
        kind: kind.into(),
        title: None,
        w: None,
        query: None,
        value: None,
        label: None,
        format: None,
        chart: None,
        markdown: None,
    }
}

#[test]
fn metric_reads_first_measure_value() {
    let r = result(
        &[("Orders.revenue", "measure")],
        vec![json!({ "Orders.revenue": 128400.0 })],
    );
    let w = BoundWidget {
        title: Some("Revenue".into()),
        w: Some(1),
        ..widget("metric")
    };
    let spec = resolve_widget(&w, Some(&r));
    assert_eq!(spec["type"], "metric");
    assert_eq!(spec["title"], "Revenue");
    assert_eq!(spec["value"], 128400.0);
}

#[test]
fn metric_picks_named_value_member() {
    let r = result(
        &[("Subs.to_grade", "measure"), ("Subs.graded", "measure")],
        vec![json!({ "Subs.to_grade": 2, "Subs.graded": 89 })],
    );
    let w = BoundWidget {
        value: Some("Subs.graded".into()),
        ..widget("metric")
    };
    let spec = resolve_widget(&w, Some(&r));
    assert_eq!(spec["value"], 89);
}

#[test]
fn metric_with_no_result_is_zero() {
    let spec = resolve_widget(&widget("metric"), None);
    assert_eq!(spec["value"], 0);
}

#[test]
fn table_maps_columns_and_rows() {
    let r = result(
        &[("Orders.status", "dimension"), ("Orders.count", "measure")],
        vec![json!({ "Orders.status": "paid", "Orders.count": 12 })],
    );
    let spec = resolve_widget(&widget("table"), Some(&r));
    assert_eq!(spec["type"], "table");
    // Column labels are humanized from the member's local name.
    let labels: Vec<_> = spec["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["label"].as_str().unwrap().to_string())
        .collect();
    assert!(labels.contains(&"Status".to_string()), "{:?}", labels);
    assert_eq!(spec["rows"].as_array().unwrap().len(), 1);
}

#[test]
fn chart_infers_x_and_y_from_columns() {
    let r = result(
        &[
            ("Activities.source", "dimension"),
            ("Activities.count", "measure"),
        ],
        vec![json!({ "Activities.source": "adhoc", "Activities.count": 108 })],
    );
    let w = BoundWidget {
        chart: Some(ChartHint {
            mark: "bar".into(),
            x: None,
            y: None,
            max: None,
            format: None,
        }),
        ..widget("chart")
    };
    let spec = resolve_widget(&w, Some(&r));
    assert_eq!(spec["chart"]["mark"], "bar");
    assert_eq!(spec["chart"]["x"], "Activities.source"); // first non-measure
    assert_eq!(spec["chart"]["y"], "Activities.count"); // first measure
    assert_eq!(spec["chart"]["series"].as_array().unwrap().len(), 1);
}

#[test]
fn note_passes_markdown_through() {
    let w = BoundWidget {
        markdown: Some("**hi**".into()),
        ..widget("note")
    };
    let spec = resolve_widget(&w, None);
    assert_eq!(spec["type"], "note");
    assert_eq!(spec["markdown"], "**hi**");
}

#[test]
fn run_filters_apply_only_to_matching_cube() {
    // A report-wide filter bar passes every filter; each widget query gets only
    // the filters that target its own cube (others would break single-cube).
    let query = Query {
        measures: vec!["Rental.count".into()],
        dimensions: vec!["Rental.staff_id".into()],
        ..Default::default()
    };
    let filters = vec![
        Filter {
            member: "Rental.staff_id".into(),
            operator: FilterOperator::Equals,
            values: vec![ScalarValue::Int(2)],
        },
        Filter {
            member: "Payment.staff_id".into(),
            operator: FilterOperator::Equals,
            values: vec![ScalarValue::Int(9)],
        },
    ];
    let out = with_run_filters(&query, &filters);
    // Only the Rental-cube filter is appended; the Payment one is skipped.
    assert_eq!(out.filters.len(), 1);
    assert_eq!(out.filters[0].member, "Rental.staff_id");
}
