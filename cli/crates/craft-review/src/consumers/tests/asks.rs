//! How the graph is asked: of the symbol's own file, non-test callers first, within one time
//! bound that keeps what was answered.

use std::path::Path;
use std::time::{Duration, Instant};

use super::{diff_of, fixture};
use crate::consumers::cbm::Cbm;
use crate::consumers::{GRAPH, build, lens_block, section};
use crate::gate::tests::exe;
use crate::project::CodeGraph;

/// A stand-in graph whose `query_graph` runs `answer` (shell, the query in `$4`), each query
/// logged to `queries`.
fn stand_in(t: &Path, answer: &str) -> CodeGraph {
    let tool = t.join("cbm");
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_status) echo '{{\"status\":\"ready\",\"indexed_at\":\"2099-01-01T00:00:00Z\",\"root_path\":\"/r\"}}';;\n query_graph) echo \"$4\" >> {log}; {answer};;\nesac\n",
        log = t.join("queries").display()
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph {
        tool: tool.display().to_string(),
        available: true,
        project: "p".into(),
        note: String::new(),
    }
}

fn queries(t: &Path) -> Vec<String> {
    let log = std::fs::read_to_string(t.join("queries")).unwrap_or_default();
    log.lines().map(str::to_owned).collect()
}

/// Asked without its file, the name answers 50 callers of a same-named function elsewhere;
/// asked of `src/lib.rs`, its own caller in `src/uses.rs`.
const OWN_FILE: &str = r#"case "$4" in *"f.file_path = 'src/lib.rs' AND NOT ("*) echo '{"rows":[["k8s_rule_to_api","src/lib.rs","src/uses.rs","3","5"]]}';; *f.file_path*) echo '{"rows":[]}';; *) echo '{"has_more":true,"rows":[["k8s_rule_to_api","src/other.rs","src/other.rs","1","1"]]}';; esac"#;

#[test]
fn the_graph_is_asked_of_the_symbol_s_own_file_non_test_callers_first() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let c = build(&repo, &diff_of(&repo), Ok(stand_in(t.path(), OWN_FILE)));
    let line4 = c.symbols[0].sites.iter().find(|s| s.line == 4);
    assert!(
        line4.is_some_and(|s| s.from.contains(&GRAPH.to_owned())),
        "{:?}",
        c.symbols
    );
    assert!(c.graph_truncated.is_empty(), "{:?}", c.graph_truncated);
    let asked = queries(t.path());
    let own: Vec<&String> = asked
        .iter()
        .filter(|q| q.contains("'k8s_rule_to_api'"))
        .collect();
    assert_eq!(own.len(), 2, "{asked:?}");
    assert!(own[0].contains("AND NOT ("), "non-test first: {}", own[0]);
    assert!(
        own[1].contains("'src/lib.rs' AND ("),
        "tests after: {}",
        own[1]
    );
    assert!(
        own[1].contains("\"max_rows\":49"),
        "the room left: {}",
        own[1]
    );
}

#[test]
fn a_symbol_whose_non_test_callers_fill_the_rows_asks_no_more() {
    let t = tempfile::tempdir().unwrap();
    let full = r#"echo '{"has_more":true,"rows":[["a","src/a.rs","src/x.rs","1","2"]]}'"#;
    let g = stand_in(t.path(), full);
    let asked = Cbm::new(&g.tool)
        .callers("p", &[("a", "src/a.rs")])
        .unwrap();
    assert_eq!(asked.truncated, vec!["a"]);
    assert_eq!(queries(t.path()).len(), 1);
}

#[test]
fn the_time_bound_keeps_what_was_answered_and_names_what_was_not_asked() {
    let t = tempfile::tempdir().unwrap();
    let slow = r#"sleep 0.4; echo '{"rows":[["a","src/a.rs","src/x.rs","1","2"]]}'"#;
    let g = stand_in(t.path(), slow);
    let cbm = Cbm {
        budget: Duration::from_millis(1000),
        ..Cbm::new(&g.tool)
    };
    let start = Instant::now();
    let symbols = [("a", "src/a.rs"), ("b", "src/b.rs"), ("c", "src/c.rs")];
    let asked = cbm.callers("p", &symbols).unwrap();
    assert!(
        start.elapsed() < Duration::from_millis(1600),
        "{:?}",
        start.elapsed()
    );
    assert!(!asked.callers.is_empty());
    assert!(asked.callers.iter().all(|c| c.symbol == "a"));
    assert_eq!(asked.unasked, vec!["b (time bound)", "c (time bound)"]);
}

#[test]
fn the_symbols_the_graph_was_not_asked_of_are_said() {
    let c = crate::consumers::Consumers {
        sources: vec!["name search".into(), GRAPH.into()],
        symbols: vec![crate::consumers::Listed {
            name: "b".into(),
            file: "a.rs".into(),
            line: 1,
            sites: vec![],
        }],
        graph_unasked: vec!["b (time bound)".into()],
        ..Default::default()
    };
    assert!(
        section(&c).contains(&format!("- {GRAPH} not asked for: b (time bound)")),
        "{}",
        section(&c)
    );
    // The name search ran for `b`: what the graph was not asked stays in the report.
    let block = lens_block(&c).unwrap();
    assert!(!block.contains("b (time bound)"), "{block}");
}
