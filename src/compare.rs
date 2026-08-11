//! Comparison-column merge — the pure half of `compare: previous_period`.
//!
//! The engine runs the same query twice (current window, shifted window) and
//! this module folds the shifted run's measures into the current rows as
//! `__prev_<measure>` columns (kind `prev_measure`). Alignment: with no time
//! buckets there is one row on each side; with buckets, rows align by their
//! time-sorted position — dense series (use `fill_gaps`) align exactly, and
//! the bucket text format sorts chronologically.

use crate::query::{Column, QueryResult, PREV_PREFIX};

/// Fold `prev`'s measure values into `current` as `__prev_<measure>` columns.
/// `measures` are the query's measure members; `time_key` is the projected
/// time-bucket column, when the query has one.
pub fn merge_prev(
    current: &mut QueryResult,
    prev: &QueryResult,
    measures: &[String],
    time_key: Option<&str>,
) {
    for measure in measures {
        current.columns.push(Column::new(
            format!("{PREV_PREFIX}{measure}"),
            "prev_measure",
        ));
    }

    // Row indices of each side in time order (identity order when no buckets).
    let order_of = |rows: &[serde_json::Map<String, serde_json::Value>]| -> Vec<usize> {
        let mut idx: Vec<usize> = (0..rows.len()).collect();
        if let Some(key) = time_key {
            idx.sort_by_key(|&i| {
                rows[i]
                    .get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            });
        }
        idx
    };
    let cur_order = order_of(&current.rows);
    let prev_order = order_of(&prev.rows);

    for (pos, &cur_i) in cur_order.iter().enumerate() {
        let prev_row = prev_order.get(pos).map(|&i| &prev.rows[i]);
        for measure in measures {
            let value = prev_row
                .and_then(|r| r.get(measure))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            current.rows[cur_i].insert(format!("{PREV_PREFIX}{measure}"), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(cols: &[(&str, &str)], rows: &[serde_json::Value]) -> QueryResult {
        QueryResult {
            columns: cols
                .iter()
                .map(|(k, kind)| Column::new(*k, *kind))
                .collect(),
            rows: rows
                .iter()
                .map(|v| v.as_object().unwrap().clone())
                .collect(),
            sql: None,
            total: None,
            has_more: false,
            truncated_at: None,
        }
    }

    #[test]
    fn metric_merge_is_a_single_row_zip() {
        let mut cur = result(
            &[("Orders.count", "measure")],
            &[json!({"Orders.count": 42})],
        );
        let prev = result(
            &[("Orders.count", "measure")],
            &[json!({"Orders.count": 30})],
        );
        merge_prev(&mut cur, &prev, &["Orders.count".into()], None);
        assert_eq!(cur.rows[0]["__prev_Orders.count"], json!(30));
        assert!(cur
            .columns
            .iter()
            .any(|c| c.key == "__prev_Orders.count" && c.kind == "prev_measure"));
    }

    #[test]
    fn series_align_by_time_sorted_position_regardless_of_row_order() {
        // Current rows arrive ordered DESC; prev rows ASC. Position in time
        // order is what aligns them: bucket 1↔1, bucket 2↔2.
        let mut cur = result(
            &[("E.day", "time"), ("E.count", "measure")],
            &[
                json!({"E.day": "2026-08-02 00:00:00+00", "E.count": 5}),
                json!({"E.day": "2026-08-01 00:00:00+00", "E.count": 3}),
            ],
        );
        let prev = result(
            &[("E.day", "time"), ("E.count", "measure")],
            &[
                json!({"E.day": "2026-07-01 00:00:00+00", "E.count": 30}),
                json!({"E.day": "2026-07-02 00:00:00+00", "E.count": 50}),
            ],
        );
        merge_prev(&mut cur, &prev, &["E.count".into()], Some("E.day"));
        // Row order preserved; first row (Aug 2, second bucket) gets July 2's 50.
        assert_eq!(cur.rows[0]["__prev_E.count"], json!(50));
        assert_eq!(cur.rows[1]["__prev_E.count"], json!(30));
    }

    #[test]
    fn missing_prev_buckets_merge_as_null_not_zero() {
        // Prev window has fewer buckets: unmatched positions are null —
        // "no data then" is not "zero then".
        let mut cur = result(
            &[("E.day", "time"), ("E.count", "measure")],
            &[
                json!({"E.day": "2026-08-01 00:00:00+00", "E.count": 3}),
                json!({"E.day": "2026-08-02 00:00:00+00", "E.count": 5}),
            ],
        );
        let prev = result(
            &[("E.day", "time"), ("E.count", "measure")],
            &[json!({"E.day": "2026-07-01 00:00:00+00", "E.count": 30})],
        );
        merge_prev(&mut cur, &prev, &["E.count".into()], Some("E.day"));
        assert_eq!(cur.rows[0]["__prev_E.count"], json!(30));
        assert_eq!(cur.rows[1]["__prev_E.count"], serde_json::Value::Null);
    }
}
