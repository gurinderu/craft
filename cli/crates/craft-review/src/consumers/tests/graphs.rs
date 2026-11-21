//! The reviewer's profile names the code graph; the probe finds the project or says why not, and
//! what it says names the step that records a graph once indexed.

use std::process::Command;

use super::{fixture, graph, repo_root};
use crate::consumers::cbm::{self, Cbm};
use crate::consumers::graph_of;
use crate::project::{self, CodeGraph, GraphState, ProjectProfile};

#[test]
fn the_profile_s_graph_is_read_and_an_unusable_one_is_named() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let projects = t.path().join("projects");
    let why = graph_of(Some(&projects), &repo).unwrap_err().to_string();
    assert!(
        why.contains("`craft init --propose` checks for one"),
        "{why}"
    );
    let (path, common) = project::profile_path(&projects, &repo).unwrap();
    let mut p = ProjectProfile::new(common, Vec::new(), Vec::new()).unwrap();
    p.code_graph = Some(CodeGraph {
        tool: cbm::TOOL.into(),
        state: GraphState::Unavailable {
            note: "codebase-memory-mcp could not run".into(),
        },
    });
    project::save(&path, &p).unwrap();
    let why = graph_of(Some(&projects), &repo).unwrap_err().to_string();
    assert!(why.contains("could not run"), "{why}");
    assert!(why.contains("record it with `craft init --write`"), "{why}");
    p.code_graph = Some(graph(t.path(), "x"));
    project::save(&path, &p).unwrap();
    assert_eq!(
        graph_of(Some(&projects), &repo).unwrap().project(),
        Some("p")
    );
}

#[test]
fn the_probe_finds_the_project_by_root_or_says_the_graph_is_not_there() {
    let t = tempfile::tempdir().unwrap();
    let g = graph(t.path(), "x");
    let found = cbm::probe(&g.tool, &["/elsewhere".into(), "/r".into()]);
    assert_eq!(found.project(), Some("p"));
    let unindexed = cbm::probe(&g.tool, &["/elsewhere".into()]);
    assert!(
        matches!(&unindexed.state, GraphState::Unindexed { note } if note.contains("no project indexes")),
        "{unindexed:?}"
    );
    let says = cbm::said(&unindexed);
    assert!(
        says.contains("indexes no project of this repository yet")
            && says.contains("a review indexes the checkout it reads itself"),
        "{says}"
    );
    assert!(!says.contains("warmup"), "{says}");
    let missing = cbm::probe(&t.path().join("none").display().to_string(), &[]);
    assert!(
        matches!(&missing.state, GraphState::Unavailable { note } if note.contains("could not run")),
        "{missing:?}"
    );
    let index = Cbm::new(&g.tool)
        .index(
            "p",
            std::time::Instant::now() + std::time::Duration::from_secs(600),
        )
        .unwrap();
    let root = repo_root(t.path());
    assert_eq!(
        (index.at.as_str(), index.root.as_str()),
        ("x", root.as_str())
    );
}

#[test]
fn a_linked_worktree_s_roots_are_its_top_level_and_its_main_checkout_once_each() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let wt = t.path().join("wt");
    let ok = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "add", "-q", "--detach"])
        .arg(&wt)
        .status()
        .unwrap();
    assert!(ok.success());
    let main = repo_root(t.path());
    let top = wt.canonicalize().unwrap().display().to_string();
    assert_eq!(cbm::roots_of(&wt), vec![top, main.clone()]);
    assert_eq!(cbm::roots_of(&repo), vec![main]);
}
