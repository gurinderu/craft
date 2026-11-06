//! What a run records of where it started, what it refuses to start over, and the harm cap on its
//! verdict.

mod common;

use common::{answers, finding, fixture, git, opts, verdict};
use craft_review::step;
use serde_json::json;

#[test]
fn a_run_dir_with_leftover_tasks_or_answers_is_refused() {
    let repo = fixture(true);
    for sub in ["tasks", "answers"] {
        let out = tempfile::tempdir().unwrap();
        let left = out.path().join("run").join(sub);
        std::fs::create_dir_all(&left).unwrap();
        std::fs::write(left.join("verify-0.json"), "{}").unwrap();
        let err = step::start(&opts(repo.path(), out.path())).unwrap_err();
        assert!(
            err.to_string().contains("holds files of another run"),
            "{err}"
        );
        assert!(!out.path().join("run/state.json").exists());
    }
    let out = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(out.path().join("run/answers")).unwrap();
    step::start(&opts(repo.path(), out.path())).unwrap();
}

#[test]
fn the_report_and_state_name_the_head_and_whether_the_tree_was_dirty() {
    let repo = fixture(false);
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let head = String::from_utf8(head.stdout).unwrap().trim().to_owned();
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains(&format!("Head `{head}`, clean tree;")),
        "{report}"
    );
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out.path().join("run/state.json")).unwrap())
            .unwrap();
    assert_eq!(
        (&state["diff"]["head"], &state["diff"]["dirty"]),
        (&json!(head), &json!(false))
    );

    std::fs::write(repo.path().join("src/notes.txt"), "changed\n").unwrap();
    std::fs::write(repo.path().join("untracked.txt"), "x\n").unwrap();
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("with uncommitted changes;"), "{report}");
    git(repo.path(), &["checkout", "--", "src/notes.txt"]);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("clean tree;"),
        "an untracked file alone is not dirty: {report}"
    );
}

#[test]
fn a_confirmed_high_naming_a_self_healing_harm_is_capped_and_does_not_block() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let mut f = finding("High", 1);
    f["harmLevel"] = json!("self-healing");
    let lens = json!({"lens": "intent", "findings": [f]});
    step::submit(&run, Some(&answers(json!({"lens-intent": lens})))).unwrap();
    let s = step::submit(&run, Some(&answers(json!({"verify-0": verdict(false)})))).unwrap();
    assert_eq!(s["verdict"], json!("Approve"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("**Low** `src/lib.rs:1`"), "{report}");
    assert!(
        report.contains("harm cap — harm level self-healing allows at most Low"),
        "{report}"
    );
}
