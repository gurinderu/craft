//! What `index_status` and `list_projects` say is read whole: a project not ready is never
//! asked, a file the index left out is named (a symbol with no callers too, when that list was
//! cut), the listing is paged to its end, and an error that is not a string is still said.

use std::path::Path;

use super::asks::queries;
use super::{diff_of, fixture, repo_root};
use crate::consumers::build;
use crate::consumers::cbm::Cbm;
use crate::gate::tests::exe;
use crate::project::CodeGraph;

/// A stand-in graph answering `index_status` with `status` (a JSON object's body, `'` free),
/// `list_projects` with `listed` (shell), and every caller query with none, logged.
fn stand_in(t: &Path, status: &str, listed: &str) -> CodeGraph {
    let tool = t.join("cbm");
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{{{status}}}';;\n list_projects) {listed};;\n query_graph) echo \"$4\" >> {log}; echo '{{\"rows\":[]}}';;\nesac\n",
        log = t.join("queries").display()
    );
    exe::write_executable(&tool, &script).unwrap();
    CodeGraph::indexed(&tool.display().to_string(), "p")
}

fn ready(t: &Path, extra: &str) -> String {
    format!(
        r#""status":"ready","indexed_at":"2099-01-01T00:00:00Z","root_path":"{}"{extra}"#,
        repo_root(t)
    )
}

#[test]
fn a_project_not_ready_is_refused_and_never_asked_for_callers() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let g = stand_in(t.path(), r#""status":"indexing""#, "true");
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert!(
        c.graph_skipped.contains(r#"is "indexing", not ready"#),
        "{}",
        c.graph_skipped
    );
    assert!(queries(t.path()).is_empty(), "{:?}", queries(t.path()));
}

#[test]
fn a_changed_symbol_in_a_file_the_index_left_out_is_named_not_asked() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let left_out = r#","not_indexed":{"files":["src/lib.rs"],"dirs":[]}"#;
    let g = stand_in(t.path(), &ready(t.path(), left_out), "true");
    let c = build(&repo, &diff_of(&repo), Ok(g));
    assert_eq!(
        c.graph_unasked,
        vec![
            "k8s_rule_to_api (file not indexed by the graph)",
            "twice (file not indexed by the graph)"
        ]
    );
    assert!(queries(t.path()).is_empty(), "{:?}", queries(t.path()));
}

#[test]
fn a_cut_list_of_left_out_paths_names_each_symbol_the_graph_gave_no_caller() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let cut = r#","not_indexed":{"files":[],"dirs":[],"truncated":true}"#;
    let g = stand_in(t.path(), &ready(t.path(), cut), "true");
    let c = build(&repo, &diff_of(&repo), Ok(g));
    let why = "no callers, and the graph's list of the files it left out was cut";
    assert!(
        c.graph_unasked
            .iter()
            .any(|u| u.starts_with("k8s_rule_to_api (") && u.contains(why)),
        "{:?}",
        c.graph_unasked
    );
}

#[test]
fn every_list_of_left_out_paths_is_read_relative_to_the_root() {
    let t = tempfile::tempdir().unwrap();
    let root = repo_root(t.path());
    let lists = format!(
        r#","not_indexed":{{"files":["a.rs"],"dirs":["{root}/gen/"]}},"parse_unusable":{{"files":[{{"path":"b.rs"}}]}},"skipped":{{"files":["{root}/c.rs"]}}"#
    );
    let g = stand_in(t.path(), &ready(t.path(), &lists), "true");
    let index = Cbm::new(&g.tool)
        .index(
            "p",
            std::time::Instant::now() + std::time::Duration::from_secs(600),
        )
        .unwrap();
    assert_eq!(index.unindexed, vec!["a.rs", "gen/", "b.rs", "c.rs"]);
    assert!(index.leaves_out("gen/x.rs") && index.leaves_out("c.rs"));
    assert!(
        !index.leaves_out("general.rs")
            && !index.leaves_out("src/a.rs")
            && !index.leaves_out("a.rs2")
    );
}

#[test]
fn the_project_listing_is_paged_to_its_end_and_a_cut_one_is_refused() {
    let t = tempfile::tempdir().unwrap();
    let paged = r#"case "$4" in *'"offset":0'*) echo '{"has_more":true,"projects":[{"name":"other","root_path":"/x"}]}';; *) echo '{"has_more":false,"projects":[{"name":"mine","root_path":"/r"}]}';; esac"#;
    let g = stand_in(t.path(), "", paged);
    let cbm = Cbm::new(&g.tool);
    assert_eq!(
        cbm.project_of(&["/r".into()]).unwrap().as_deref(),
        Some("mine")
    );
    let empty_more = r#"echo '{"has_more":true,"projects":[]}'"#;
    let g = stand_in(t.path(), "", empty_more);
    let why = Cbm::new(&g.tool).project_of(&["/r".into()]).unwrap_err();
    assert!(why.to_string().contains("the listing was cut"), "{why}");
    let endless = r#"echo '{"has_more":true,"projects":[{"name":"other","root_path":"/x"}]}'"#;
    let g = stand_in(t.path(), "", endless);
    let why = Cbm::new(&g.tool).project_of(&["/r".into()]).unwrap_err();
    assert!(why.to_string().contains("cut after 20 projects"), "{why}");
}

#[test]
fn an_error_that_is_not_a_string_is_said_as_it_is() {
    let t = tempfile::tempdir().unwrap();
    let g = stand_in(t.path(), "", r#"echo '{"error":{"code":5}}'; exit 1"#);
    let why = Cbm::new(&g.tool).project_of(&["/r".into()]).unwrap_err();
    assert_eq!(why.to_string(), r#"list_projects: {"code":5}"#);
}
