//! The memory's judges end to end over a fixture repository: a decision whose finding only the
//! match judge recognizes, reworded, and a project rule the rule judge puts a finding under.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::Command;

use common::{assert_contains_all, fixture, ids, lens, opts, prompt_of, scout, submit, titled};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

fn head(repo: &Path) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A run over `repo` into `out`, recalling `recall` with `passed` handed in, its one round's
/// `errors` lens reporting `found` and every finding confirmed: the step after verification.
fn verified(
    repo: &Path,
    out: &Path,
    passed: Option<Value>,
    recall: Value,
    found: &[Value],
) -> Value {
    let run = out.join("run");
    step::start(&StartOptions {
        recall: true,
        prior_decisions: passed.map(Ok),
        ..opts(repo, out)
    })
    .unwrap();
    submit(
        &run,
        json!({"scout-rust": scout("small", &["errors"]), "memory-recall": recall}),
    );
    let s = submit(
        &run,
        json!({
            "lens-rust-errors-r1": lens("errors", found),
            "lens-rust-intent-r1": lens("intent", &[]),
            "lens-rust-tests-r1": lens("tests", &[]),
        }),
    );
    if ids(&s) == ["dedup-rust"] {
        submit(&run, json!({"dedup-rust": {"groups": []}}));
    }
    let v: Vec<Value> = (0..found.len())
        .map(|i| json!({"index": i, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "seen"}))
        .collect();
    submit(&run, json!({"verify-batch-0": {"verdicts": v}}))
}

/// The report a finished step names.
fn report(done: &Value) -> String {
    std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap()
}

/// A rejected decision on `f` at line 1, and its finding raised again twenty lines off in other
/// words: no title rule matches it, only the judge. The finished step and its report.
fn reworded(answer: Value) -> (Value, String) {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let rejected = json!([{
        "kind": "decision", "title": "f returns the wrong constant", "body": "1 is the intended value",
        "scope": "src/lib.rs", "author": "rev", "date": "2026-05-01", "commit": head(repo.path()),
        "line": 1, "lens": "errors"
    }]);
    let nothing = json!({"backend": "none", "why": "no memory configured", "decisions": []});
    let found = [titled(
        "Medium",
        21,
        "callers get one where zero is expected",
    )];
    let s = verified(repo.path(), out.path(), Some(rejected), nothing, &found);
    assert_eq!(ids(&s), ["match-judge"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            "whether a remembered record (a decision or a deferred question",
            r#""record":{"kind":"decision","id":"decision-"#,
            r#""title":"f returns the wrong constant","file":"src/lib.rs","line":1,"lens":"errors""#,
            r#""finding":{"title":"callers get one where zero is expected","file":"src/lib.rs","line":21,"lens":"errors""#,
        ],
    );
    let done = submit(&out.path().join("run"), json!({"match-judge": answer}));
    let text = report(&done);
    (done, text)
}

#[test]
fn a_decision_only_the_judge_matches_sets_its_reworded_finding_aside() {
    let same = json!({"verdicts": [{"pair": 0, "same": true, "violates": false, "why": "the same constant, reworded"}]});
    let (done, text) = reworded(same);
    assert_eq!(done["verdict"], json!("Approve"));
    assert_eq!(done["findings"], json!([]));
    assert_eq!(done["ledger"][0]["disposition"], json!("rejected"));
    assert_contains_all(
        &text,
        &[
            "## Rejected before (set aside — not in the verdict)\n- Medium · `src/lib.rs:21` · callers get one where zero is expected · wrong · REJECTED BEFORE: 1 is the intended value",
            "· matched by judge: the same constant, reworded",
            "prior decisions: match judge: 1 disputed pair(s) judged, 1 the same",
        ],
    );

    // Without its verdict the title rule decides, and these titles share too few words.
    let (done, text) = reworded(json!({"verdicts": []}));
    assert_eq!(done["verdict"], json!("Warning"));
    assert_contains_all(
        &text,
        &[
            "## Prior decisions not applied\n- ⚠️ the match judge returned no verdict for 1 disputed record–finding pair(s)",
        ],
    );
}

#[test]
fn a_project_rule_the_judge_puts_a_finding_under_covers_it() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let recall = json!({
        "backend": "repo", "why": "the .craft/memory directory", "decisions": [],
        "rules": [{"id": "rule-0123456789", "title": "f may return any constant", "body": "callers ignore it", "scope": "src", "status": "active"}]
    });
    let found = [
        titled("Medium", 1, "f returns 1, not 0"),
        titled("Medium", 5, "f is not documented"),
    ];
    let s = verified(repo.path(), out.path(), None, recall, &found);
    assert_eq!(ids(&s), ["rule-judge"], "no decision: only the rule judge");
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            "whether a finding of this code review falls under a project rule",
            r#""rule":{"id":"rule-0123456789","rule":"f may return any constant","scope":"src","lens":""}"#,
        ],
    );
    let done = submit(
        &out.path().join("run"),
        json!({"rule-judge": {"verdicts": [
            {"pair": 0, "covered": true, "violates": false, "why": "the constant is the rule's"},
            {"pair": 1, "covered": false, "violates": false, "why": "documentation is another concern"},
        ]}}),
    );
    assert_eq!(
        done["verdict"],
        json!("Warning"),
        "only the uncovered one stays"
    );
    let titles: Vec<&str> = done["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["f is not documented"]);
    let covered = done["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["title"] == "f returns 1, not 0")
        .unwrap();
    assert_eq!(covered["disposition"], json!("covered"));
    assert_contains_all(
        &report(&done),
        &[
            "## Covered by project rules (not in the verdict)\n- Medium · `src/lib.rs:1` · f returns 1, not 0 · rule rule-0123456789 \"f may return any constant\" · covered by judge: the constant is the rule's",
            "project rules: 1 project rule(s) given, 2 rule–finding pair(s), 1 finding(s) covered",
        ],
    );
}
