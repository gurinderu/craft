use std::path::PathBuf;

use serde_json::json;

use super::*;

fn task(graph: bool) -> Task {
    Task::of(&json!({
        "id": "t", "label": "t", "model": "opus",
        "promptFile": "/p", "schemaFile": "/s", "answerFile": "/a",
        "kind": "lens", "graph": graph,
    }))
    .unwrap()
}

#[test]
fn the_wire_graph_flag_is_read() {
    assert!(task(true).graph);
    assert!(!task(false).graph);
    assert_eq!(task(true).prompt_file, PathBuf::from("/p"));
}

#[test]
fn a_code_graph_task_on_pi_is_named_degraded_and_on_codex_or_opencode_is_not() {
    assert!(without_graph(&task(true), HostKind::Pi));
    for host in [HostKind::Codex, HostKind::OpenCode] {
        assert!(!without_graph(&task(true), host));
    }
    assert!(!without_graph(&task(false), HostKind::Pi));
    let p = Prepared {
        graphless: 2,
        ..Prepared::default()
    };
    let notes = p.notes(1, "pi");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(
        notes[0].starts_with("round 1: 2 task(s) ask for the code graph's MCP tools, which pi runs its agents without"),
        "{}",
        notes[0]
    );
    assert!(Prepared::default().notes(1, "pi").is_empty());
}
