//! A pass the budget cuts short, its record landed in the store, and a resume over what it left.

use serde_json::{Value, json};

use super::{craft, ids, ok, scratch, start, submit};

fn clean(step: &Value) {
    for t in step["tasks"].as_array().unwrap() {
        let file = t["answerFile"].as_str().unwrap();
        std::fs::write(file, json!({"lens": "l", "findings": []}).to_string()).unwrap();
    }
}

#[test]
fn a_pass_the_budget_cuts_short_files_its_record_and_a_resume_reads_only_what_it_left() {
    let s = scratch(&["src/lib.rs", "tool.py"]);
    let first = start(&s, &["--lens-agents", "1", "--batch-bytes", "4"]);
    assert_eq!(ids(&first), ["lens-1-rust-correctness-0"], "{first}");
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(s.run.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["args"]["craftVersion"], "9.9.9");
    assert_eq!(state["args"]["record"]["session"], "s-9");
    assert_eq!(state["args"]["batchBytes"], 4);
    clean(&first);
    let done = submit(&s, &[]);
    assert_eq!(done["verdict"], "INCOMPLETE", "{done}");
    let unread = std::fs::read_to_string(done["unread"]["file"].as_str().unwrap()).unwrap();
    assert_eq!(unread, "src/lib.rs\ntool.py\n");
    assert_eq!(done["filing"]["record"], "filed", "{done}");
    let index = std::fs::read_to_string(s.home.join(".craft/runs/index.jsonl")).unwrap();
    assert!(index.contains("\"name\":\"audit\""), "{index}");
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("## Verdict\n\n**INCOMPLETE**"), "{report}");
    let second = submit(&s, &["--resume"]);
    assert_eq!(second["pass"], 2);
    assert_eq!(ids(&second), ["lens-2-rust-security-0"], "{second}");
    let run = s.run.display().to_string();
    let st = ok(&craft(&s, &["audit", "status", "--run", &run]));
    assert_eq!(
        (st["phase"].clone(), st["pass"].clone()),
        (json!("lens"), json!(2))
    );
}
