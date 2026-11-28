//! Answers handed in by `--answers`, one JSON object by task id, rather than by the answer files.

use serde_json::{Value, json};

use super::{ids, scratch, start, submit};

#[test]
fn answers_handed_in_by_file_end_the_audit() {
    let s = scratch(&["tool.py"]);
    let first = start(&s, &[]);
    let answers: serde_json::Map<String, Value> = ids(&first)
        .into_iter()
        .map(|id| (id, json!({"lens": "l", "findings": []})))
        .collect();
    let file = s.run.join("given.json");
    std::fs::write(&file, Value::Object(answers).to_string()).unwrap();
    let done = submit(&s, &["--answers", file.to_str().unwrap()]);
    assert_eq!(done["verdict"], "Approve", "{done}");
}
