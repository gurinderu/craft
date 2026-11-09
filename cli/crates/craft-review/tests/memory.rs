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
        prior_decisions: passed.map(Ok),
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

/// The match judge's answer: `same` for each pair it names.
fn judged(pairs: &[(usize, bool)]) -> Value {
    let v: Vec<Value> = pairs
        .iter()
        .map(|(p, same)| json!({"pair": p, "same": same, "violates": false, "why": "judged"}))
        .collect();
    json!({"verdicts": v})
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
        ids(&s),
        ["match-judge"],
        "the unrelated finding shares the record's lens: a candidate the judge decides"
    );
    let s = submit(&run, json!({"match-judge": judged(&[(0, false)])}));
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
    // The finished step carries the report's memory part verbatim, for a parent that reads only it.
    let sections = s["memorySections"].as_str().unwrap();
    assert!(
        sections.contains("## Rejected before (set aside — not in the verdict)\n- Medium")
            && sections.contains("\n\n## Memory\n- memory: none — no memory configured"),
        "{sections}"
    );
    assert!(report.contains(sections), "as it stands in the report");
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
    assert_eq!(
        ids(&s),
        ["match-judge"],
        "a directory scope compares no line"
    );
    let s = submit(&run, json!({"match-judge": judged(&[(0, true)])}));
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

/// Answers every task of `s` until the run is done: the scout picks `errors`, the recall finds
/// nothing, `errors` reports `first` in round 1 of the chain, the verifiers confirm and each
/// adjudicator finds its prior still open.
fn drive(run: &Path, s: Value, first: &[Value]) -> Value {
    drive_as(run, s, first, "still-open")
}

/// [`drive`], each adjudicator answering `status`.
fn drive_as(run: &Path, mut s: Value, first: &[Value], status: &str) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if id == "memory-recall" {
                nothing_recalled()
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let name = rest.split('-').next().unwrap();
                lens(name, if name == "errors" { first } else { &[] })
            } else if id.starts_with("adjudicate-") {
                json!({"status": status, "currentLine": 0, "note": "", "invariant": "i", "attack": ""})
            } else if id == "match-judge" {
                // No verdict: each pair falls back to the title rule, as without the judge.
                json!({"verdicts": []})
            } else {
                assert_eq!(id, "verify-batch-0");
                confirmed(&[0])
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

#[test]
fn a_deferred_finding_stays_known_and_deferred_while_its_question_holds() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    let question = json!([{
        "id": "question-abcdef0123", "kind": "question", "title": "retry budget of fetch",
        "body": "decide after the load test", "scope": "src/lib.rs", "deferred": true,
        "commit": rev(repo.path(), "HEAD"), "line": 1, "lens": "errors", "author": "nick"
    }]);
    let start = |name: &str| StartOptions {
        run_dir: runs.path().join(name),
        recall: true,
        prior_decisions: Some(Ok(question.clone())),
        ..opts(repo.path(), runs.path())
    };
    let one = drive(
        &runs.path().join("r1"),
        step::start(&start("r1")).unwrap(),
        &[titled("Medium", 1, "retry budget of fetch is unbounded")],
    );
    assert_eq!(one["verdict"], json!("Approve"));
    let row = &one["ledger"][0];
    assert_eq!(
        (&row["disposition"], &row["deferral"]["id"]),
        (&json!("deferred"), &json!("question-abcdef0123"))
    );

    // A fix elsewhere: the deferred code is unchanged and the question still active.
    std::fs::write(repo.path().join("src/other.rs"), "pub fn g() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "fix: elsewhere"]);
    let s = step::start(&start("r2")).unwrap();
    assert_eq!(
        ids(&s),
        ["scout-rust", "memory-recall"],
        "its code unchanged, a held deferral needs no adjudicator"
    );
    let two = drive(&runs.path().join("r2"), s, &[]);
    assert_eq!(
        two["verdict"],
        json!("Approve"),
        "the held deferral holds no verdict"
    );
    let row = &two["ledger"][0];
    assert_eq!(
        (&row["disposition"], &row["deferral"]["id"]),
        (&json!("deferred"), &json!("question-abcdef0123"))
    );
    let report = std::fs::read_to_string(two["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "Known and deferred (its question still holds)",
            "## Known and deferred (open question — not in the verdict)\n- Medium · `src/lib.rs:1` · retry budget of fetch is unbounded",
        ],
    );
}

#[test]
fn a_deferred_finding_whose_code_changed_since_its_question_counts_by_its_adjudication() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    let question = json!([{
        "id": "question-abcdef0123", "kind": "question", "title": "retry budget of fetch",
        "body": "decide after the load test", "scope": "src/lib.rs", "deferred": true,
        "commit": rev(repo.path(), "HEAD"), "line": 1, "lens": "errors"
    }]);
    let start = |name: &str| StartOptions {
        run_dir: runs.path().join(name),
        recall: true,
        prior_decisions: Some(Ok(question.clone())),
        ..opts(repo.path(), runs.path())
    };
    let one = drive(
        &runs.path().join("r1"),
        step::start(&start("r1")).unwrap(),
        &[titled("Medium", 1, "retry budget of fetch is unbounded")],
    );
    assert_eq!(one["verdict"], json!("Approve"));
    // Round 2 edits the deferred function and makes it worse.
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    common::git(repo.path(), &["commit", "-qam", "feat: f returns 2"]);
    let s = step::start(&start("r2")).unwrap();
    assert_eq!(ids(&s), ["scout-rust", "memory-recall", "adjudicate-0"]);
    let two = drive_as(&runs.path().join("r2"), s, &[], "regressed");
    assert_eq!(
        two["verdict"],
        json!("Warning"),
        "the regressed defect counts again"
    );
    assert_eq!(two["reReview"]["regressed"], json!(1));
}

#[test]
fn a_remembered_decision_sets_aside_a_prior_still_open() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    let one = drive(
        &runs.path().join("r1"),
        step::start(&StartOptions {
            run_dir: runs.path().join("r1"),
            ..opts(repo.path(), runs.path())
        })
        .unwrap(),
        &[titled("Medium", 1, "f returns 1 instead of 0")],
    );
    assert_eq!(one["verdict"], json!("Warning"));
    std::fs::write(repo.path().join("src/other.rs"), "pub fn g() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "fix: elsewhere"]);
    let rejected = json!([{
        "id": "decision-0011223344", "kind": "decision", "title": "f returns 1 instead of 0",
        "body": "1 is intended", "scope": "src/lib.rs", "commit": rev(repo.path(), "HEAD"),
        "line": 1, "lens": "errors"
    }]);
    let two = drive(
        &runs.path().join("r2"),
        step::start(&StartOptions {
            run_dir: runs.path().join("r2"),
            prior_decisions: Some(Ok(rejected)),
            ..opts(repo.path(), runs.path())
        })
        .unwrap(),
        &[],
    );
    assert_eq!(
        two["verdict"],
        json!("Approve"),
        "the prior set aside holds no verdict"
    );
    let ledger = two["ledger"].as_array().unwrap();
    assert_eq!(ledger.len(), 1, "{ledger:?}");
    assert_eq!(ledger[0]["disposition"], json!("rejected"));
    let report = std::fs::read_to_string(two["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "Set aside by a remembered record",
            "## Rejected before (set aside — not in the verdict)\n- Medium · `src/lib.rs:1` · f returns 1 instead of 0",
        ],
    );
}

#[test]
fn an_unreadable_launcher_list_is_refused_and_the_review_runs() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&StartOptions {
        prior_decisions: Some(Err("- is not JSON: expected value at line 1".into())),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let done = drive(&out.path().join("run"), s, &[]);
    assert_eq!(done["verdict"], json!("Approve"));
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("## Prior decisions not applied\n- ⚠️ priorDecisions could not be read (- is not JSON: expected value at line 1) — no decision applied"),
        "{report}"
    );
}

#[test]
fn a_priors_deferral_released_by_a_record_that_answers_its_question_counts_again() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    let head = rev(repo.path(), "HEAD");
    let question = json!({
        "id": "question-abcdef0123", "kind": "question", "title": "retry budget of fetch",
        "body": "decide after the load test", "scope": "src/lib.rs", "deferred": true,
        "commit": head, "line": 1, "lens": "errors"
    });
    let one = drive(
        &runs.path().join("r1"),
        step::start(&StartOptions {
            run_dir: runs.path().join("r1"),
            recall: true,
            prior_decisions: Some(Ok(json!([question]))),
            ..opts(repo.path(), runs.path())
        })
        .unwrap(),
        &[titled("Medium", 1, "retry budget of fetch is unbounded")],
    );
    assert_eq!(one["verdict"], json!("Approve"));
    std::fs::write(repo.path().join("src/other.rs"), "pub fn g() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "fix: elsewhere"]);
    let answer = json!([{
        "id": "decision-0011223344", "kind": "decision", "title": "the retry budget is unbounded on purpose",
        "body": "answered: load test passed", "scope": "lib", "links": ["answers: question-abcdef0123"]
    }]);
    let s = step::start(&StartOptions {
        run_dir: runs.path().join("r2"),
        recall: true,
        prior_decisions: Some(Ok(answer)),
        ..opts(repo.path(), runs.path())
    })
    .unwrap();
    let two = drive(&runs.path().join("r2"), s, &[]);
    assert_eq!(
        two["verdict"],
        json!("Warning"),
        "released, the prior is adjudicated and counts"
    );
    let report = std::fs::read_to_string(two["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("the deferral on src/lib.rs:1 no longer holds"),
        "{report}"
    );
}
