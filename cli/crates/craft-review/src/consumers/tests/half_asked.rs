//! A symbol half asked: its test question failed, its rows full, or some of its rows unreadable;
//! and a first question that fails, which leaves the graph out.

use std::time::Duration;

use super::asks::{queries, stand_in};
use super::{diff_of, fixture};
use crate::consumers::cbm::Cbm;
use crate::consumers::{GRAPH, build};

/// A non-test question answered at once with one caller of the asked name; a test question
/// answered by `tests` (shell).
fn tests_answer(tests: &str) -> String {
    format!(
        r#"case "$4" in *"AND NOT ("*) n=$(echo "$4" | sed -n "s/.*f.name = '\([a-z]*\)'.*/\1/p"); echo "{{\"rows\":[[\"$n\",\"src/$n.rs\",\"src/x.rs\",\"1\",\"2\"]]}}";; *) {tests};; esac"#
    )
}

#[test]
fn a_first_symbol_whose_test_question_fails_keeps_its_non_test_callers() {
    let t = tempfile::tempdir().unwrap();
    let g = stand_in(t.path(), &tests_answer("echo boom >&2; exit 1"));
    let asked = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap();
    assert_eq!(asked.callers.len(), 1, "{asked:?}");
    assert_eq!(
        asked.unasked,
        vec!["a (test callers not asked: query_graph: boom)"]
    );
}

#[test]
fn a_later_symbol_whose_test_question_runs_past_the_bound_keeps_its_non_test_callers() {
    let t = tempfile::tempdir().unwrap();
    let tests = r#"case "$4" in *"f.name = 'a'"*) echo '{"rows":[]}';; *) sleep 3;; esac"#;
    let g = stand_in(t.path(), &tests_answer(tests));
    let cbm = Cbm {
        budget: Duration::from_millis(1000),
        ..Cbm::new(&g.tool)
    };
    let symbols = [("a", "src/a.rs"), ("b", "src/b.rs"), ("c", "src/c.rs")];
    let asked = cbm.callers("p", &symbols).unwrap();
    let names: Vec<&str> = asked.callers.iter().map(|c| c.symbol.as_str()).collect();
    assert_eq!(names, vec!["a", "b"]);
    assert_eq!(
        asked.unasked,
        vec!["b (test callers not asked: time bound)", "c (time bound)"]
    );
}

#[test]
fn non_test_callers_that_fill_the_rows_leave_the_test_callers_unasked_not_truncated() {
    let t = tempfile::tempdir().unwrap();
    let row = r#"[\"a\",\"src/a.rs\",\"src/x.rs\",\"1\",\"2\"]"#;
    let rows = vec![row; 50].join(",");
    let g = stand_in(
        t.path(),
        &format!(r#"echo "{{\"has_more\":false,\"rows\":[{rows}]}}""#),
    );
    let asked = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap();
    assert_eq!(asked.callers.len(), 50);
    assert!(asked.truncated.is_empty(), "{:?}", asked.truncated);
    assert_eq!(
        asked.unasked,
        vec!["a (test callers not asked: the row budget is spent)"]
    );
    assert_eq!(queries(t.path()).len(), 1);
}

#[test]
fn an_answer_with_no_rows_is_refused_not_read_as_no_callers() {
    let t = tempfile::tempdir().unwrap();
    let g = stand_in(t.path(), r#"echo '{"columns":[]}'"#);
    let why = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap_err()
        .to_string();
    assert!(why.contains("no rows"), "{why}");
    let later = tests_answer(r#"echo '{"rows":[]}'"#).replace(
        r#"*"AND NOT ("*)"#,
        r#"*"f.name = 'b'"*) echo '{"columns":[]}';; *"AND NOT ("*)"#,
    );
    let g = stand_in(t.path(), &later);
    let asked = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs"), ("b", "src/b.rs")])
        .unwrap();
    assert_eq!(
        asked.unasked,
        vec!["b (query_graph: its answer holds no rows)"]
    );
}

#[test]
fn rows_that_do_not_read_as_callers_are_named_not_dropped() {
    let t = tempfile::tempdir().unwrap();
    let rows = r#"echo '{"rows":[["a","src/a.rs","src/x.rs",null,"2"],["a","src/a.rs","src/x.rs","1.5","2"],["a","src/a.rs","src/y.rs","3","4"]]}'"#;
    let g = stand_in(t.path(), rows);
    let asked = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap();
    assert_eq!(
        asked.callers.len(),
        2,
        "both questions' good row: {asked:?}"
    );
    assert_eq!(asked.unasked, vec!["a (4 of its caller rows unreadable)"]);
}

#[test]
fn a_first_question_that_fails_leaves_the_graph_out_of_the_sources() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = stand_in(t.path(), "echo 'database locked' >&2; exit 1");
    let why = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap_err()
        .to_string();
    assert!(why.contains("database locked"), "{why}");
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(c.graph_skipped.contains("database locked"), "{c:?}");
    assert!(!c.sources.contains(&GRAPH.to_owned()), "{:?}", c.sources);
}
