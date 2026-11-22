//! The graph's numbers of the functions the change touches, read by the binary for the metrics
//! lenses: only a function whose span holds a changed line, each count and flag as the graph
//! prints it; a failed question says why, and no number is kept.

use std::path::Path;

use super::{diff_of, fixture, repo_root};
use crate::consumers::build_for_metrics;
use crate::gate::tests::exe;
use crate::project::CodeGraph;

/// The columns of the metrics question as codebase-memory-mcp 0.12.1 names them (node #613).
pub(super) const COLS: &str = r#""columns":["f.name","f.start_line","f.end_line","f.cognitive","f.complexity","f.loop_depth","f.transitive_loop_depth","f.param_count","f.linear_scan_in_loop","f.alloc_in_loop","f.recursion_in_loop","f.unguarded_recursion"]"#;

/// One row of `name` over `start..=end`, its numbers as the graph prints them.
pub(super) fn row(name: &str, start: u32, end: u32) -> String {
    format!(r#"["{name}","{start}","{end}","2","1","0","0","1","0","false","false","1"]"#)
}

/// A stand-in graph, ready at the fixture's root (`status` more of its status), answering the
/// metrics question with `rows` (shell: what it prints); once that question is asked, with
/// `moves`, its index reads as another run's.
pub(super) fn stand_in(t: &Path, (status, rows, moves): (&str, &str, bool)) -> CodeGraph {
    let tool = t.join("cbm");
    let marker = t.join("asked");
    let at = |day: u8| {
        format!(
            r#"{{"status":"ready","indexed_at":"2099-01-0{day}T00:00:00Z","root_path":"{}"{status}}}"#,
            repo_root(t)
        )
    };
    let status = if moves {
        format!(
            "if [ -e '{}' ]; then echo '{}'; else echo '{}'; fi",
            marker.display(),
            at(2),
            at(1)
        )
    } else {
        format!("echo '{}'", at(1))
    };
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo '{{\"status\":\"indexed\"}}';;\n index_status) {status};;\n list_projects) true;;\n query_graph) case \"$4\" in *'IS NOT NULL'*) touch '{}'; {rows};; *) echo '{{\"rows\":[]}}';; esac;;\nesac\n",
        marker.display()
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

#[test]
fn only_the_functions_whose_span_holds_a_changed_line_are_measured() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let rows = format!(
        r#"echo '{{{COLS},"rows":[{},["far","40","50","9","9","0","0","1","1","true","true","false"]]}}'"#,
        row("k8s_rule_to_api", 1, 3)
    );
    let c = build_for_metrics(
        &repo,
        &diff_of(&repo),
        Ok(stand_in(t.path(), ("", &rows, false))),
    );
    assert!(c.graph_indexed && c.metrics_failed.is_empty(), "{c:?}");
    assert!(c.metrics_unread.is_empty(), "{:?}", c.metrics_unread);
    let names: Vec<_> = c
        .metrics
        .iter()
        .map(|m| (m.file.as_str(), m.function.as_str(), m.start, m.end))
        .collect();
    assert_eq!(names, [("src/lib.rs", "k8s_rule_to_api", 1, 3)]);
    assert_eq!(c.metrics[0].metrics["cognitive"], 2);
    assert_eq!(c.metrics[0].metrics["linear_scan_in_loop"], false);
    assert_eq!(c.metrics[0].metrics["unguarded_recursion"], true);
}

#[test]
fn a_failed_metrics_question_says_why_and_keeps_no_number() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    for (rows, why) in [
        (
            r#"echo '{"error":"no such property"}'; exit 1"#.to_owned(),
            "no such property",
        ),
        (
            format!(r#"echo '{{"rows":[{}]}}'"#, row("k8s_rule_to_api", 1, 3)),
            "names no column `f.name`",
        ),
    ] {
        let c = build_for_metrics(
            &repo,
            &diff_of(&repo),
            Ok(stand_in(t.path(), ("", &rows, false))),
        );
        assert!(c.metrics.is_empty());
        assert!(c.metrics_failed.contains(why), "{}", c.metrics_failed);
    }
}

#[test]
fn an_index_that_moved_while_the_numbers_were_read_drops_them_and_the_graph() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let rows = format!(
        r#"echo '{{{COLS},"rows":[{}]}}'"#,
        row("k8s_rule_to_api", 1, 3)
    );
    let c = build_for_metrics(
        &repo,
        &diff_of(&repo),
        Ok(stand_in(t.path(), ("", &rows, true))),
    );
    assert!(c.metrics.is_empty(), "{c:?}");
    assert!(
        c.metrics_failed
            .contains("changed while the numbers of the functions the change touches were read"),
        "{}",
        c.metrics_failed
    );
    assert!(!c.graph_indexed, "the index may be another checkout's now");
    assert!(
        c.graph_skipped.is_empty(),
        "the callers, asked first, stand: {}",
        c.graph_skipped
    );
}
