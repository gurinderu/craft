//! The graph indexes the checkout the review reads before it is asked (realm @nick/craft, node
//! #529): one `index_repository` within the list's graph budget, always under craft's own project
//! for the repository, never the one the profile records; a reindex that does not finish leaves
//! the graph unasked and says why; an index that moved while its callers were asked has its
//! answers dropped (node #533).

use std::path::Path;

use super::{diff_of, fixture, repo_root, sites};
use crate::consumers::{GRAPH, NAME_SEARCH, build};
use crate::gate::tests::exe;
use crate::project::{CodeGraph, GraphState};

/// A stand-in graph: `index_status` (each asked logged) of the profile's `p` names `root`, of any
/// other project `own`; `index_repository` logs its argument and runs `reindex`; `query_graph`
/// answers `rows` for `k8s_rule_to_api`. `index_status` names a later time from its second call
/// on when `moves`.
pub(super) fn graph_of_own(
    t: &Path,
    (root, own): (&str, &str),
    reindex: &str,
    rows: &str,
    moves: bool,
) -> CodeGraph {
    let tool = t.join("cbm");
    let calls = t.join("status-calls");
    let late = if moves { "2099-06-01" } else { "2099-01-01" };
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_status) echo \"$4\" >> {calls}; n=$(wc -l < {calls}); at=2099-01-01; [ \"$n\" -ge 2 ] && at={late}; case \"$4\" in *'\"project\":\"p\"'*) r='{root}';; *) r='{own}';; esac; echo \"{{\\\"status\\\":\\\"ready\\\",\\\"indexed_at\\\":\\\"${{at}}T00:00:00Z\\\",\\\"root_path\\\":\\\"$r\\\"}}\";;\n index_repository) echo \"$4\" >> {log}; {reindex};;\n query_graph) echo \"$4\" >> {queries}; case \"$4\" in *k8s_rule_to_api*) echo '{{\"rows\":[{rows}]}}';; *) echo '{{\"rows\":[]}}';; esac;;\nesac\n",
        calls = calls.display(),
        log = t.join("reindexed").display(),
        queries = t.join("queries").display(),
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

/// [`graph_of_own`], craft's own project at the fixture's checkout.
pub(super) fn graph(t: &Path, root: &str, reindex: &str, rows: &str, moves: bool) -> CodeGraph {
    graph_of_own(t, (root, &repo_root(t)), reindex, rows, moves)
}

pub(super) const INDEXED: &str = "echo '{\"status\":\"indexed\"}'";
pub(super) const ROW: &str = r#"["k8s_rule_to_api","src/lib.rs","src/uses.rs","1","5","4"]"#;

pub(super) fn reindexed(t: &Path) -> String {
    std::fs::read_to_string(t.join("reindexed")).unwrap_or_default()
}

#[test]
fn a_profile_project_at_this_checkout_is_never_indexed_or_asked_and_craft_s_own_is_used() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = graph(t.path(), &repo_root(t.path()), INDEXED, ROW, false);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let log = reindexed(t.path());
    assert!(
        log.contains(&format!(r#""repo_path":"{}""#, repo_root(t.path())))
            && log.contains(r#""mode":"full""#)
            && log.contains(r#""name":"craft-review-"#)
            && !log.contains(r#""name":"p""#),
        "{log}"
    );
    let status = std::fs::read_to_string(t.path().join("status-calls")).unwrap();
    assert!(!status.contains(r#""project":"p""#), "{status}");
    assert_eq!(c.sources, vec![NAME_SEARCH, GRAPH], "{}", c.graph_skipped);
}

#[test]
fn another_checkout_is_indexed_under_craft_s_one_project_for_the_repository() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = graph(t.path(), "/main/checkout", INDEXED, ROW, false);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let log = reindexed(t.path());
    assert!(log.contains(r#""name":"craft-review-"#), "{log}");
    assert!(!log.contains(r#""name":"p""#), "{log}");
    let queries = std::fs::read_to_string(t.path().join("queries")).unwrap();
    assert!(queries.contains(r#""project":"craft-review-"#), "{queries}");
    assert_eq!(c.sources, vec![NAME_SEARCH, GRAPH], "{}", c.graph_skipped);
}

#[test]
fn an_unindexed_profile_is_indexed_under_craft_s_project_too() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let mut g = graph(t.path(), "/main/checkout", INDEXED, ROW, false);
    g.state = GraphState::Unindexed {
        note: "no project indexes it".into(),
    };
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(reindexed(t.path()).contains(r#""name":"craft-review-"#));
    assert_eq!(c.sources, vec![NAME_SEARCH, GRAPH], "{}", c.graph_skipped);
}

#[test]
fn a_reindex_that_fails_or_runs_out_of_time_leaves_the_graph_unasked_and_says_why() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let failing = "echo '{\"error\":\"database locked\"}'; exit 1";
    let g = graph(t.path(), &repo_root(t.path()), failing, ROW, false);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert_eq!(c.sources, vec![NAME_SEARCH]);
    assert!(
        c.graph_skipped.contains("could not index this checkout")
            && c.graph_skipped.contains("database locked"),
        "{}",
        c.graph_skipped
    );
    assert!(!t.path().join("queries").exists(), "the graph was asked");
}

#[test]
fn an_index_that_moved_while_it_was_asked_has_its_answers_dropped() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = graph(t.path(), &repo_root(t.path()), INDEXED, ROW, true);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert_eq!(c.sources, vec![NAME_SEARCH], "{c:?}");
    assert!(
        c.graph_skipped
            .contains("changed while its callers were asked"),
        "{}",
        c.graph_skipped
    );
}

#[test]
fn every_edge_is_asked_and_the_call_line_is_the_one_listed() {
    let t = tempfile::tempdir().unwrap();
    // A span of lines 1–5 of src/uses.rs, which names the symbol on line 1 (`use`) and line 4
    // (`.map(k8s_rule_to_api)`); the edge's own line is 4.
    let repo = fixture(t.path(), "");
    let g = graph(t.path(), &repo_root(t.path()), INDEXED, ROW, false);
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let queries = std::fs::read_to_string(t.path().join("queries")).unwrap();
    assert!(!queries.contains("confidence"), "{queries}");
    assert!(queries.contains("r.line"), "{queries}");
    let from_graph: Vec<u32> = sites(&c, "k8s_rule_to_api")
        .into_iter()
        .filter(|(_, _, from)| from.iter().any(|f| f == GRAPH))
        .map(|(_, line, _)| line)
        .collect();
    assert_eq!(from_graph, vec![4]);
}
