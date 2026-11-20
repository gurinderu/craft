//! The re-anchor step through the step protocol (realm @nick/craft, node #547): a finding whose
//! line is past its file's end, naming a symbol the head file holds on one line, reaches its
//! verifier at that line and is reported with the line it came from.

mod common;

use common::{fixture, git, ids, lens, opts, scout, submit, titled};
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn a_finding_past_the_end_reaches_its_verifier_and_report_at_its_symbols_line() {
    let repo = fixture(true);
    let d = repo.path();
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn f() -> u8 { 1 }\n\npub fn head_lines() -> u8 { 2 }\n",
    )
    .unwrap();
    git(d, &["commit", "-qam", "feat: add head_lines"]);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut off = titled("High", 603, "head_lines returns the wrong value");
    off["symbol"] = json!("head_lines");
    let found = [off];
    let mut s = step::start(&opts(d, out.path())).unwrap();
    let mut verifiers = 0;
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for (i, id) in ids(&s).into_iter().enumerate() {
            let a = if id.starts_with("scout-") {
                scout("small", &["intent"])
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let name = rest.split('-').next().unwrap();
                let mine = name == "intent" && rest.ends_with("-r1");
                lens(name, if mine { &found } else { &[] })
            } else {
                assert!(id.starts_with("verify-"), "{id}");
                let label = s["tasks"][i]["label"].as_str().unwrap();
                assert!(label.starts_with("verify:src/lib.rs:3#"), "{label}");
                verifiers += 1;
                common::verdict(false)
            };
            answers.insert(id, a);
        }
        s = submit(&run, Value::Object(answers));
    }
    assert!(verifiers > 0, "the finding reached no verifier");
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("`src/lib.rs:3` (line corrected from 603)"),
        "{report}"
    );
    assert!(
        report.contains("1 finding(s) moved to the line of the symbol they name"),
        "{report}"
    );
}
