//! The graph's numbers of the functions the change touches, read by the binary for the metrics
//! lenses: only a function whose span holds a changed line, each count and flag as the graph
//! prints it; a failed question says why, and no number is kept.

use std::path::Path;

use super::{diff_of, fixture, repo_root};
use crate::consumers::build_for_metrics;
use crate::gate::tests::exe;
use crate::project::CodeGraph;

/// A stand-in graph, ready at the fixture's root, answering the metrics question with `rows`
/// (shell: what it prints).
fn stand_in(t: &Path, rows: &str) -> CodeGraph {
    let tool = t.join("cbm");
    let status = format!(
        r#"{{"status":"ready","indexed_at":"2099-01-01T00:00:00Z","root_path":"{}"}}"#,
        repo_root(t)
    );
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{status}';;\n list_projects) true;;\n query_graph) case \"$4\" in *'IS NOT NULL'*) {rows};; *) echo '{{\"rows\":[]}}';; esac;;\nesac\n"
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

#[test]
fn only_the_functions_whose_span_holds_a_changed_line_are_measured() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let rows = r#"echo '{"rows":[["k8s_rule_to_api","1","3","2","1","0","0","1","0","false","false","1"],["far","40","50","9","9","0","0","1","1","true","true","false"]]}'"#;
    let c = build_for_metrics(&repo, &diff_of(&repo), Ok(stand_in(t.path(), rows)));
    assert!(c.graph_indexed && c.metrics_failed.is_empty(), "{c:?}");
    let names: Vec<_> = c
        .metrics
        .iter()
        .map(|m| (m.file.as_str(), m.function.as_str()))
        .collect();
    assert_eq!(names, [("src/lib.rs", "k8s_rule_to_api")]);
    assert_eq!(c.metrics[0].metrics["cognitive"], 2);
    assert_eq!(c.metrics[0].metrics["linear_scan_in_loop"], false);
}

#[test]
fn a_failed_metrics_question_says_why_and_keeps_no_number() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let rows = r#"echo '{"error":"no such property"}'; exit 1"#;
    let c = build_for_metrics(&repo, &diff_of(&repo), Ok(stand_in(t.path(), rows)));
    assert!(c.metrics.is_empty());
    assert!(
        c.metrics_failed.contains("no such property"),
        "{}",
        c.metrics_failed
    );
}
