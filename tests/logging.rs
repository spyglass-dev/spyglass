//! Query-log exporter + usage analyzer.

use spyglass::logging::{analyze_lines, JsonFileExporter, QueryEvent, QueryExporter};

fn ev(cube: &str, measures: &[&str], dims: &[&str], dur: u64, rows: usize) -> QueryEvent {
    QueryEvent {
        ts_ms: 1,
        cube: Some(cube.to_string()),
        measures: measures.iter().map(|s| s.to_string()).collect(),
        dimensions: dims.iter().map(|s| s.to_string()).collect(),
        filter_count: 0,
        scope_keys: vec![format!("{cube}.workspace_id")],
        duration_ms: dur,
        row_count: rows,
    }
}

#[test]
fn analyze_aggregates_usage() {
    let lines = vec![
        serde_json::to_string(&ev(
            "Submissions",
            &["Submissions.to_grade"],
            &["Submissions.class_id"],
            10,
            3,
        ))
        .unwrap(),
        serde_json::to_string(&ev("Submissions", &["Submissions.count"], &[], 20, 1)).unwrap(),
        serde_json::to_string(&ev(
            "Activities",
            &["Activities.count"],
            &["Activities.class_id"],
            30,
            5,
        ))
        .unwrap(),
        "   ".to_string(),        // blank — skipped
        "{not json}".to_string(), // malformed — skipped
    ];
    let stats = analyze_lines(lines.iter().map(|s| s.as_str()));
    assert_eq!(stats.total_queries, 3);
    assert_eq!(stats.by_cube.get("Submissions"), Some(&2));
    assert_eq!(stats.by_cube.get("Activities"), Some(&1));
    assert_eq!(stats.by_measure.get("Submissions.count"), Some(&1));
    assert_eq!(stats.by_dimension.get("Activities.class_id"), Some(&1));
    assert_eq!(stats.avg_duration_ms, 20.0);
    assert_eq!(stats.avg_row_count, 3.0);
}

#[test]
fn json_file_exporter_roundtrips() {
    // Unique temp dir without external deps or Date/rand.
    let dir = std::env::temp_dir().join(format!("reporting-log-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let exporter = JsonFileExporter::new(&dir).expect("create exporter");
    exporter.export(&ev("Submissions", &["Submissions.count"], &[], 5, 2));
    exporter.export(&ev("Activities", &["Activities.count"], &[], 7, 4));

    let stats = spyglass::analyze_log(exporter.path()).expect("read log");
    assert_eq!(stats.total_queries, 2);
    assert_eq!(stats.by_cube.get("Submissions"), Some(&1));
    let _ = std::fs::remove_dir_all(&dir);
}
