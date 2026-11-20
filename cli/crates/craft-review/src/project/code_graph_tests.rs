//! A `[code_graph]` section of a shape this binary does not read leaves the rest of the profile
//! readable and reads as a graph not to be asked, saying why.

use super::{CodeGraph, GraphState, IntegrationPoint, ProjectProfile, load, save};

fn profile_with(section: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p/review.toml");
    let point =
        IntegrationPoint::parse("kube-ovn=https://github.com/kubeovn/kube-ovn@v1.12.3").unwrap();
    let p = ProjectProfile::new("/r/.git".into(), vec![point], Vec::new()).unwrap();
    save(&path, &p).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{text}\n[code_graph]\n{section}\n")).unwrap();
    (dir, path)
}

fn unreadable(section: &str) -> (String, String) {
    let (_dir, path) = profile_with(section);
    let p = load(&path).unwrap().unwrap();
    assert_eq!(p.integrations.len(), 1, "{p:?}");
    match p.code_graph {
        Some(CodeGraph {
            tool,
            state: GraphState::Unreadable { note },
        }) => (tool, note),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_earlier_shape_reads_as_unreadable_and_keeps_the_points() {
    let (tool, note) =
        unreadable("tool = \"codebase-memory-mcp\"\navailable = true\nproject = \"p\"");
    assert_eq!(tool, "codebase-memory-mcp");
    assert!(
        note.contains("of a shape this craft does not read"),
        "{note}"
    );
}

#[test]
fn a_later_state_or_no_tool_reads_as_unreadable_and_keeps_the_points() {
    let (tool, _) = unreadable("tool = \"codebase-memory-mcp\"\nstate = \"indexed_lazily\"");
    assert_eq!(tool, "codebase-memory-mcp");
    let (tool, _) = unreadable("state = \"indexed\"\nproject = \"p\"");
    assert_eq!(tool, "the code graph");
}

#[test]
fn a_known_shape_reads_as_it_is() {
    let (_dir, path) = profile_with("tool = \"cbm\"\nstate = \"indexed\"\nproject = \"p\"");
    let p = load(&path).unwrap().unwrap();
    assert_eq!(p.code_graph, Some(CodeGraph::indexed("cbm", "p")));
}
