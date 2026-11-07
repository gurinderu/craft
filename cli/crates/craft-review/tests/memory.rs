//! What the review knows beyond the diff, end to end over a fixture repository: the memory recall
//! beside the scout, the launcher's records, a rejected finding set aside rather than reported
//! again, and strict mode's maintainability bar.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::{assert_contains_all, fixture, ids, lens, opts, prompt_of, scout, submit, titled};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// The commit `rev` names in `repo`.
fn rev(repo: &Path, rev: &str) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", rev])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A recall that found nothing.
fn nothing_recalled() -> Value {
    json!({"backend": "none", "why": "no memory configured", "decisions": []})
}

/// A run over `repo` that recalls, `passed` handed in, its scout picking `errors` and its recall
/// answering `recall`: the run directory and the lens step.
fn recalled_run(repo: &Path, out: &Path, passed: Option<Value>, recall: Value) -> (PathBuf, Value) {
    let run = out.join("run");
    let start = StartOptions {
        recall: true,
        prior_decisions: passed,
        ..opts(repo, out)
    };
    let s = step::start(&start).unwrap();
    assert_eq!(ids(&s), ["scout-rust", "memory-recall"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][1]),
        &[
            "WORKING DIRECTORY: this review targets the repository at",
            "Invoke the craft:memory skill",
            "Scope: these changed paths of the diff:\n- src/lib.rs\n",
        ],
    );
    let s = submit(
        &run,
        json!({"scout-rust": scout("small", &["errors"]), "memory-recall": recall}),
    );
    (run, s)
}

/// The small run's round 1, `errors` reporting `findings`.
fn round1(findings: &[Value]) -> Value {
    json!({
        "lens-rust-errors-r1": lens("errors", findings),
        "lens-rust-intent-r1": lens("intent", &[]),
        "lens-rust-tests-r1": lens("tests", &[]),
    })
}

/// A batch verdict confirming the findings at `indices`.
fn confirmed(indices: &[usize]) -> Value {
    let v: Vec<Value> = indices
        .iter()
        .map(|i| json!({"index": i, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "seen"}))
        .collect();
    json!({"verdicts": v})
}

#[test]
fn a_finding_rejected_on_the_pr_is_set_aside_not_reported_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let head = rev(repo.path(), "HEAD");
    let rejected = json!([{
        "kind": "decision", "title": "f returns 1 instead of 0", "body": "1 is the intended value",
        "scope": "src/lib.rs", "author": "rev", "date": "2026-05-01", "commit": head, "line": 1,
        "lens": "errors", "links": ["https://github.com/o/r/pull/1#discussion_r1"]
    }]);
    let (run, _) = recalled_run(repo.path(), out.path(), Some(rejected), nothing_recalled());
    submit(
        &run,
        round1(&[
            titled("Medium", 1, "f returns 1, not 0"),
            titled("Medium", 40, "an unrelated defect"),
        ]),
    );
    let s = submit(&run, json!({"dedup-rust": {"groups": []}}));
    assert_eq!(ids(&s), ["verify-batch-0"]);
    let s = submit(&run, json!({"verify-batch-0": confirmed(&[0, 1])}));
    assert_eq!(
        s["verdict"],
        json!("Warning"),
        "only the unrelated finding holds the verdict"
    );
    let titles: Vec<&str> = s["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        titles,
        ["an unrelated defect"],
        "the rejected finding is not reported again"
    );
    let row = s["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["title"] == "f returns 1, not 0")
        .unwrap();
    assert_eq!(
        (&row["disposition"], &row["tier"]),
        (&json!("rejected"), &json!("confirmed"))
    );
    assert_eq!(s["memory"]["passed"], json!(1));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "## Rejected before (set aside — not in the verdict)\n- Medium · `src/lib.rs:1` · f returns 1, not 0 · wrong · REJECTED BEFORE: 1 is the intended value — rev, 2026-05-01, https://github.com/o/r/pull/1#discussion_r1 (decision decision-",
            "· matched by file:line+lens",
            "## Memory\n- memory: none — no memory configured (backend none); plus 1 passed by the launcher; id derived for 1 record(s)",
            "prior decisions: 1 decision(s) given, 1 finding(s) set aside as rejected before, 0 raised again",
        ],
    );
}

#[test]
fn a_recalled_decision_whose_scope_changed_since_raises_its_finding_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let before = rev(repo.path(), "origin/main");
    let recall = json!({
        "backend": "repo", "why": "the .craft/memory directory", "decisions": [{
            "id": "decision-0123456789", "kind": "decision", "title": "f returns 1 instead of 0",
            "body": "fine", "scope": "src", "status": "active", "commit": before, "line": 1, "lens": "errors"
        }]
    });
    let (run, _) = recalled_run(repo.path(), out.path(), None, recall);
    submit(
        &run,
        round1(&[titled("Medium", 1, "f returns 1 instead of 0")]),
    );
    let s = submit(&run, json!({"verify-batch-0": confirmed(&[0])}));
    assert_eq!(s["verdict"], json!("Warning"));
    assert_eq!(s["findings"].as_array().unwrap().len(), 1);
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            &format!(
                "Rejected before (decision decision-0123456789, author not recorded, date not recorded) — raised again: the code in src changed since {before}"
            ),
            "memory: recalled 1 decision(s) from repo (the .craft/memory directory)",
        ],
    );
    assert!(!report.contains("## Rejected before"), "{report}");
}

/// A maintainability finding its lens raised to Medium, naming no harm the cap would keep.
fn maintainability() -> Value {
    let mut f = titled("Medium", 1, "spaghetti branch in f");
    f["harmLevel"] = json!("none");
    f["harm"] = json!("");
    f
}

/// A small run, `strict` or not, its scout picking `picks`, its lenses answering, the one
/// maintainability finding confirmed: the finished step.
fn maintainability_run(strict: bool, picks: &[&str]) -> (Value, Value) {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let s = step::start(&StartOptions {
        strict,
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let scout_prompt = prompt_of(&s["tasks"][0]);
    let s = submit(&run, json!({"scout-rust": scout("small", picks)}));
    let lenses = ids(&s);
    assert!(
        lenses.contains(&"lens-rust-maintainability-r1".to_owned()),
        "{lenses:?}"
    );
    let at = lenses
        .iter()
        .position(|l| l == "lens-rust-maintainability-r1")
        .unwrap();
    let lens_prompt = prompt_of(&s["tasks"][at]);
    let mut answers = serde_json::Map::new();
    for id in &lenses {
        let name = id.trim_start_matches("lens-rust-").trim_end_matches("-r1");
        let found = if name == "maintainability" {
            vec![maintainability()]
        } else {
            Vec::new()
        };
        answers.insert(id.clone(), lens(name, &found));
    }
    submit(&run, Value::Object(answers));
    let s = submit(&run, json!({"verify-batch-0": confirmed(&[0])}));
    (json!({"scout": scout_prompt, "lens": lens_prompt}), s)
}

#[test]
fn strict_mode_runs_the_maintainability_lens_and_a_confirmed_finding_of_it_blocks() {
    let (prompts, s) = maintainability_run(true, &["errors"]);
    assert!(
        prompts["scout"]
            .as_str()
            .unwrap()
            .contains("STRICT MODE is on: ALWAYS include 'maintainability'")
    );
    assert!(
        prompts["lens"]
            .as_str()
            .unwrap()
            .contains("STRICT MODE: apply the maintainability bar as a *presumption of block*")
    );
    assert_eq!(s["verdict"], json!("Block"));
    assert_eq!(s["strict"], json!(true));
    assert_eq!(
        s["findings"][0]["severity"],
        json!("Medium"),
        "the harm cap spares it"
    );
    assert!(
        s["line"]
            .as_str()
            .unwrap()
            .contains("strict maintainability mode escalated it")
    );

    let (prompts, s) = maintainability_run(false, &["errors", "maintainability"]);
    assert!(!prompts["lens"].as_str().unwrap().contains("STRICT MODE"));
    assert_eq!(
        s["verdict"],
        json!("Approve"),
        "outside strict mode the cap lowers it to Low"
    );
    assert_eq!(s["findings"][0]["severity"], json!("Low"));
}
