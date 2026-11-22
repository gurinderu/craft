//! The metrics question and the reading of its answer's rows.

use serde_json::json;

use super::{function, functions_query, properties};

/// The column of property `p` in the question's own RETURN order.
fn at(p: &str) -> Option<usize> {
    properties().position(|q| q == p)
}

#[test]
fn a_row_reads_its_counts_as_numbers_and_its_flags_in_either_spelling() {
    // As codebase-memory-mcp 0.12.1 answered (realm @nick/craft, node #530).
    let row = json!([
        "sync", "964", "1014", "24", "11", "0", "2", "4", "0", "1", "false", "true"
    ]);
    let f = function(&row, &at).unwrap();
    assert_eq!((f.name.as_str(), f.start, f.end), ("sync", 964, 1014));
    assert_eq!(
        serde_json::Value::Object(f.metrics),
        json!({"cognitive": 24, "complexity": 11, "loop_depth": 0, "transitive_loop_depth": 2,
            "param_count": 4, "linear_scan_in_loop": false, "alloc_in_loop": true,
            "recursion_in_loop": false, "unguarded_recursion": true})
    );
    let odd = function(&json!(["f", "1", "2", "x", null]), &at).unwrap();
    assert!(
        odd.metrics.is_empty(),
        "a cell that does not read is left out"
    );
    assert!(function(&json!(["f", "one", "2"]), &at).is_none());
}

#[test]
fn a_cell_is_read_by_its_column_not_its_place() {
    let swapped = |p: &str| match p {
        "name" => Some(1),
        "start_line" => Some(0),
        "end_line" => Some(2),
        "cognitive" => Some(3),
        _ => None,
    };
    let f = function(&json!(["7", "g", "9", "5"]), &swapped).unwrap();
    assert_eq!((f.name.as_str(), f.start, f.end), ("g", 7, 9));
    assert_eq!(
        serde_json::Value::Object(f.metrics),
        json!({"cognitive": 5})
    );
}

#[test]
fn the_question_returns_each_property_it_reads() {
    let q = functions_query("\"a.rs\"", 3);
    let cols: Vec<String> = properties().map(|p| format!("f.{p}")).collect();
    assert!(
        q.contains(&format!("RETURN {} LIMIT 3", cols.join(", "))),
        "{q}"
    );
}
