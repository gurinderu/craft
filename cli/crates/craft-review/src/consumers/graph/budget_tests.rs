//! The graph's budget between its two questions: the callers come first, but may not take the
//! floor kept for the metrics read; a metrics read the budget cut short says so.

use std::time::{Duration, Instant};

use super::metrics::graph_metrics;
use super::{GraphError, Ready, ask};
use crate::consumers::cbm::{Cbm, Index};
use crate::consumers::symbols::Symbol;
use crate::gate::lines::Lines;
use crate::gate::tests::exe;

/// A graph whose every call is logged to `log` and answers no rows, ready until `left` from now.
fn ready(t: &std::path::Path, left: Duration) -> (Ready, std::path::PathBuf) {
    let tool = t.join("cbm");
    let log = t.join("calls");
    let script = format!(
        "#!/bin/sh\necho \"$3 $4\" >> '{}'\necho '{{\"columns\":[],\"rows\":[]}}'\n",
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

fn found() -> [Symbol; 1] {
    [Symbol {
        name: "f".into(),
        file: "src/a.rs".into(),
        line: 1,
    }]
}

fn changed() -> Lines {
    Lines::parse(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -0,0 +1,2 @@\n+a\n+b\n",
    )
}

/// Which of the two questions the graph was asked: the callers', the metrics'.
fn asked(log: &std::path::Path) -> (bool, bool) {
    let calls = std::fs::read_to_string(log).unwrap_or_default();
    let q: Vec<&str> = calls
        .lines()
        .filter(|l| l.starts_with("query_graph"))
        .collect();
    (
        q.iter().any(|l| !l.contains("IS NOT NULL")),
        q.iter().any(|l| l.contains("IS NOT NULL")),
    )
}

#[test]
fn with_a_metrics_lens_the_callers_leave_the_floor_and_say_the_budget_ran_out() {
    let t = tempfile::tempdir().unwrap();
    let (r, log) = ready(t.path(), Duration::from_secs(20));
    let (callers, read) = ask(&r, &found(), &changed(), true);
    let why = callers.unwrap_err();
    assert!(
        why.to_string()
            .contains("the graph's budget ran out before its callers"),
        "{why}"
    );
    assert!(read.is_some());
    assert_eq!(
        asked(&log),
        (false, true),
        "the floor went to the metrics alone"
    );
}

#[test]
fn without_one_the_callers_take_the_whole_budget() {
    let t = tempfile::tempdir().unwrap();
    let (r, log) = ready(t.path(), Duration::from_secs(20));
    let (_, read) = ask(&r, &found(), &changed(), false);
    assert!(read.is_none());
    assert_eq!(asked(&log), (true, false));
}

#[test]
fn with_one_the_callers_still_get_the_budget_above_the_floor() {
    let t = tempfile::tempdir().unwrap();
    let (r, log) = ready(t.path(), Duration::from_secs(40));
    let _answers = ask(&r, &found(), &changed(), true);
    assert_eq!(asked(&log), (true, true));
}

#[test]
fn a_metrics_read_the_budget_cut_short_says_the_budget_ran_out() {
    let t = tempfile::tempdir().unwrap();
    let (r, _) = ready(t.path(), Duration::ZERO);
    let why = graph_metrics(&r, &changed()).unwrap_err();
    assert!(matches!(why, GraphError::Spent { .. }), "{why}");
    assert!(
        why.to_string()
            .starts_with("the graph's budget ran out before"),
        "{why}"
    );
}
