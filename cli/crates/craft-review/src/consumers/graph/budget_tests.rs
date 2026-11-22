//! The graph's budget between its two questions: the callers come first, but may not take the
//! floor kept for the metrics read; a metrics read the budget cut short says so.

use std::time::{Duration, Instant};

use super::{GraphError, Ready, graph_callers, graph_metrics};
use crate::consumers::cbm::{Cbm, Index};
use crate::consumers::symbols::Symbol;
use crate::gate::lines::Lines;
use crate::gate::tests::exe;

/// A graph whose every call is logged to `log` and answers no rows, ready until `left` from now.
fn ready(t: &std::path::Path, left: Duration) -> (Ready, std::path::PathBuf) {
    let tool = t.join("cbm");
    let log = t.join("calls");
    let script = format!(
        "#!/bin/sh\necho \"$3\" >> '{}'\necho '{{\"columns\":[],\"rows\":[]}}'\n",
        log.display()
    );
    exe::write_executable(&tool, &script).unwrap();
    let r = Ready {
        cbm: Cbm::new(&tool.display().to_string()),
        project: "p".into(),
        index: Index::default(),
        deadline: Instant::now() + left,
    };
    (r, log)
}

#[test]
fn the_callers_leave_the_metrics_floor_untouched() {
    let t = tempfile::tempdir().unwrap();
    let (r, log) = ready(t.path(), Duration::from_secs(10));
    let found = [Symbol {
        name: "f".into(),
        file: "src/a.rs".into(),
        line: 1,
    }];
    // All that is left is the floor: the callers ask nothing of it.
    let _asked = graph_callers(&r, &found, Duration::from_secs(10));
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(!calls.contains("query_graph"), "{calls}");
}

#[test]
fn a_metrics_read_the_budget_cut_short_says_the_budget_ran_out() {
    let t = tempfile::tempdir().unwrap();
    let (r, _) = ready(t.path(), Duration::ZERO);
    let changed = Lines::parse(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -0,0 +1,2 @@\n+a\n+b\n",
    );
    let why = graph_metrics(&r, &changed).unwrap_err();
    assert!(matches!(why, GraphError::Spent { .. }), "{why}");
    assert!(
        why.to_string()
            .starts_with("the graph's budget ran out before"),
        "{why}"
    );
}
