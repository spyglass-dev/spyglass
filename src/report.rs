//! Bound reports — a saveable report *template* whose widgets bind to queries,
//! plus the pure resolver that turns query results into **data-bearing** widget
//! specs (the `ReportDoc`/`WidgetSpec` JSON that `@spyglass/ui` renders).
//!
//! The agent authors a [`BoundReport`] (widgets reference `Cube.member`
//! queries); the host runs each query under a tenant scope and calls
//! [`resolve_widget`] to bake the result into the widget — so the same report
//! re-runs live against any workspace.

use crate::query::{Query, QueryResult, ScalarValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// A report template: ordered widgets, each optionally bound to a query, plus a
/// default tenant scope applied when running.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default scope (e.g. `{ "Orders.workspace_id": "ws_1" }`). A run request
    /// can add to / override it.
    #[serde(default)]
    pub scope: BTreeMap<String, ScalarValue>,
    pub widgets: Vec<BoundWidget>,
}

/// One widget. `kind` is `metric` | `table` | `chart` | `note`. Data widgets
/// carry a `query`; `note` is static.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundWidget {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Query>,
    /// metric: which measure member to read (default: first measure column).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// chart hints (mark + x/y member overrides).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<ChartHint>,
    /// note: markdown source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartHint {
    pub mark: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// `"Orders.revenue"` → `"Revenue"`, `"activity_submissions.to_grade"` → `"To grade"`.
fn humanize(key: &str) -> String {
    let local = key.rsplit('.').next().unwrap_or(key);
    let mut s = local.replace('_', " ");
    if let Some(first) = s.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    s
}

fn rows_as_values(result: &QueryResult) -> Vec<Value> {
    result.rows.iter().cloned().map(Value::Object).collect()
}

/// Resolve one bound widget + its (optional) query result into a data-bearing
/// `WidgetSpec` JSON object (matching `@spyglass/ui`).
pub fn resolve_widget(widget: &BoundWidget, result: Option<&QueryResult>) -> Value {
    let mut spec = Map::new();
    spec.insert("type".into(), json!(widget.kind));
    if let Some(t) = &widget.title {
        spec.insert("title".into(), json!(t));
    }
    if let Some(w) = widget.w {
        spec.insert("w".into(), json!(w));
    }

    match widget.kind.as_str() {
        "metric" => {
            let value = result
                .and_then(|r| {
                    let member = widget
                        .value
                        .clone()
                        .or_else(|| first_of_kind(r, "measure"))?;
                    r.rows.first().and_then(|row| row.get(&member)).cloned()
                })
                .unwrap_or(json!(0));
            spec.insert("value".into(), value);
            if let Some(l) = &widget.label {
                spec.insert("label".into(), json!(l));
            }
            if let Some(f) = &widget.format {
                spec.insert("format".into(), json!(f));
            }
        }
        "table" => {
            let (columns, rows) = match result {
                Some(r) => (
                    r.columns
                        .iter()
                        .map(|c| json!({ "key": c.key, "label": humanize(&c.key) }))
                        .collect::<Vec<_>>(),
                    rows_as_values(r),
                ),
                None => (vec![], vec![]),
            };
            spec.insert("columns".into(), json!(columns));
            spec.insert("rows".into(), json!(rows));
        }
        "chart" => {
            let hint = widget.chart.clone().unwrap_or(ChartHint {
                mark: "bar".into(),
                x: None,
                y: None,
                max: None,
                format: None,
            });
            let mut chart = Map::new();
            chart.insert("mark".into(), json!(hint.mark));
            let (x, y, series) = match result {
                Some(r) => (
                    hint.x.clone().or_else(|| first_not_measure(r)),
                    hint.y.clone().or_else(|| first_of_kind(r, "measure")),
                    rows_as_values(r),
                ),
                None => (hint.x.clone(), hint.y.clone(), vec![]),
            };
            if let Some(x) = x {
                chart.insert("x".into(), json!(x));
            }
            chart.insert("y".into(), json!(y.unwrap_or_default()));
            chart.insert("series".into(), json!(series));
            if let Some(m) = hint.max {
                chart.insert("max".into(), json!(m));
            }
            if let Some(f) = hint.format {
                chart.insert("format".into(), json!(f));
            }
            spec.insert("chart".into(), Value::Object(chart));
        }
        "note" => {
            spec.insert(
                "markdown".into(),
                json!(widget.markdown.clone().unwrap_or_default()),
            );
        }
        _ => {} // unknown kinds pass through as-is (title/w only)
    }
    Value::Object(spec)
}

fn first_of_kind(result: &QueryResult, kind: &str) -> Option<String> {
    result
        .columns
        .iter()
        .find(|c| c.kind == kind)
        .map(|c| c.key.clone())
}

fn first_not_measure(result: &QueryResult) -> Option<String> {
    result
        .columns
        .iter()
        .find(|c| c.kind != "measure")
        .map(|c| c.key.clone())
}

/// Assemble the resolved `ReportDoc` from a report + its resolved widgets.
pub fn report_doc(report: &BoundReport, widgets: Vec<Value>) -> Value {
    json!({
        "title": report.title,
        "description": report.description,
        "widgets": widgets,
    })
}
