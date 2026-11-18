//! The reviewer's profile names the code graph; the probe finds the project or says why not.

use super::{fixture, graph};
use crate::consumers::cbm::{self, Cbm};
use crate::consumers::graph_of;
use crate::project::{self, CodeGraph, ProjectProfile};

#[test]
fn the_profile_s_graph_is_read_and_an_unusable_one_is_named() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let projects = t.path().join("projects");
    let (path, common) = project::profile_path(&projects, &repo).unwrap();
    let mut p = ProjectProfile::new(common, Vec::new(), Vec::new()).unwrap();
    p.code_graph = Some(CodeGraph {
        tool: cbm::TOOL.into(),
        available: false,
        project: String::new(),
        note: "codebase-memory-mcp could not run".into(),
    });
    project::save(&path, &p).unwrap();
    let why = graph_of(Some(&projects), &repo).unwrap_err();
    assert!(why.contains("could not run"), "{why}");
    p.code_graph = Some(graph(t.path(), "x"));
    project::save(&path, &p).unwrap();
    assert_eq!(graph_of(Some(&projects), &repo).unwrap().project, "p");
}

#[test]
fn the_probe_finds_the_project_by_root_or_says_the_graph_is_not_there() {
    let t = tempfile::tempdir().unwrap();
    let g = graph(t.path(), "x");
    let found = cbm::probe(&g.tool, &["/elsewhere".into(), "/r".into()]);
    assert_eq!((found.available, found.project.as_str()), (true, "p"));
    let unindexed = cbm::probe(&g.tool, &["/elsewhere".into()]);
    assert!(unindexed.available && unindexed.project.is_empty());
    assert!(unindexed.note.contains("no project indexes"));
    let says = cbm::said(&unindexed, &["/elsewhere".into()]);
    assert!(
        says.contains(r#"`codebase-memory-mcp cli index_repository '{"mode":"fast","repo_path":"/elsewhere"}'`"#),
        "{says}"
    );
    assert!(!says.contains("warmup"), "{says}");
    let missing = cbm::probe(&t.path().join("none").display().to_string(), &[]);
    assert!(!missing.available);
    assert!(missing.note.contains("could not run"), "{}", missing.note);
    assert_eq!(Cbm::new(&g.tool).indexed_at("p").unwrap(), "x");
}
