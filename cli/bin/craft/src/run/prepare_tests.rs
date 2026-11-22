use std::path::PathBuf;

use serde_json::json;

use super::*;

#[test]
fn a_wire_task_is_read_and_a_round_with_nothing_weaker_notes_nothing() {
    let task = Task::of(&json!({
        "id": "t", "label": "t", "model": "opus",
        "promptFile": "/p", "schemaFile": "/s", "answerFile": "/a", "kind": "lens",
    }))
    .unwrap();
    assert_eq!(task.prompt_file, PathBuf::from("/p"));
    assert_eq!(task.kind.as_deref(), Some("lens"));
    assert!(Prepared::default().notes(1, "pi").is_empty());
}
