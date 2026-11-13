//! A branch reviewed as a chain of rounds: the second run builds on
//! the first, reviews only the fix commits, adjudicates what the first left open and reports
//! nothing twice; `fresh` starts a new chain and `full_every` widens a round to the whole diff.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};

use common::{assert_contains_all, fixture, git, ids, lens, prompt_of, scout, submit, titled};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// A High finding of rule `rule` at `src/lib.rs:<line>`.
fn found(rule: &str, line: u32, title: &str) -> Value {
    let mut f = titled("High", line, title);
    f["ruleId"] = json!(rule);
    f
}

/// The options of a run in `<runs>/<name>`, which looks for earlier rounds in `runs`.
fn at(repo: &Path, runs: &Path, name: &str) -> StartOptions {
    StartOptions {
        run_dir: runs.join(name),
        ..common::opts(repo, runs)
    }
}

/// Answers every task of `s` until the run is done: the scout plans the small set, the lenses of
/// round 1 report `first`, later rounds nothing, the dedup groups nothing, each verifier confirms,
/// and each adjudicator answers as `adjudicate` says by the prior's index.
fn drive(run: &Path, mut s: Value, first: &[Value], adjudicate: &[(&str, &str)]) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let name = rest.split('-').next().unwrap();
                let mine = name == "errors" && rest.ends_with("-r1");
                lens(name, if mine { first } else { &[] })
            } else if id.starts_with("dedup-") {
                json!({"groups": []})
            } else if let Some(i) = id.strip_prefix("adjudicate-") {
                let (status, attack) = adjudicate[i.parse::<usize>().unwrap()];
                json!({"status": status, "currentLine": 0, "note": "", "invariant": "i", "attack": attack})
            } else if id.starts_with("red-team-") {
                json!({"defeated": false, "attack": ""})
            } else {
                assert!(id.starts_with("verify-") && !id.contains("batch"), "{id}");
                common::verdict(false)
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

/// Round 1 of `repo` in `<runs>/r1`: X and Y, both confirmed, Block.
fn round_one(repo: &Path, runs: &Path) -> Value {
    let s = step::start(&at(repo, runs, "r1")).unwrap();
    let first = [
        found("RS-X", 1, "X: f returns 1"),
        found("RS-Y", 1, "Y: f has no error path"),
    ];
    let done = drive(&runs.join("r1"), s, &first, &[]);
    assert_eq!(
        (&done["verdict"], &done["round"]),
        (&json!("Block"), &json!(1))
    );
    assert_eq!(done["reReview"]["chained"], json!(false));
    assert_eq!(done["lensScope"], json!("full"));
    let ledger: Vec<&str> = done["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["disposition"].as_str().unwrap())
        .collect();
    assert_eq!(ledger, ["open", "open"]);
    done
}

/// A fix commit: `src/lib.rs` changed, so the delta since round 1 holds it.
fn fix(repo: &Path) -> String {
    std::fs::write(repo.join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(repo, &["commit", "-qam", "fix: f returns 0"]);
    head(repo)
}

fn head(repo: &Path) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn runs() -> (tempfile::TempDir, PathBuf) {
    let out = tempfile::tempdir().unwrap();
    let path = out.path().to_path_buf();
    (out, path)
}

#[test]
fn the_second_round_reviews_the_fixes_adjudicates_the_first_and_reports_nothing_twice() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    let one = round_one(repo.path(), &runs);
    let r1_head = one["head"].as_str().unwrap().to_owned();
    fix(repo.path());

    let s = step::start(&at(repo.path(), &runs, "r2")).unwrap();
    assert_eq!(ids(&s), ["scout-rust", "adjudicate-0", "adjudicate-1"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[&format!("git diff --stat '{r1_head}'...HEAD")],
    );
    assert_contains_all(
        &prompt_of(&s["tasks"][1]),
        &[
            "You are adjudicating whether a prior review finding is still present",
            "FINDING: [High] X: f returns 1",
            "rule RS-X",
        ],
    );
    let r2 = runs.join("r2");
    let s = submit(
        &r2,
        json!({
            "scout-rust": scout("small", &["errors"]),
            "adjudicate-0": {"status": "resolved", "currentLine": 1, "note": "", "invariant": "i", "attack": ""},
            "adjudicate-1": {"status": "still-open", "currentLine": 1, "note": "", "invariant": "i", "attack": "f still has none"},
        }),
    );
    // The resolved High X is attacked by a red team before the lenses run.
    assert_eq!(ids(&s), ["red-team-0"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            "Attack the fix. Shell + read only",
            "FINDING: [High] X: f returns 1",
            "INVARIANT it violated: i",
        ],
    );
    let s = submit(
        &r2,
        json!({"red-team-0": {"defeated": false, "attack": ""}}),
    );
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            &format!("--merge-base '{r1_head}' -- '*.rs'"),
            "RE-REVIEW: you are reviewing ONLY the fix commits since the prior round",
        ],
    );
    // A lens re-reports Y in other words: it is absorbed into the still-open prior.
    let done = drive(&r2, s, &[found("RS-Y", 1, "no error path in f")], &[]);
    assert_eq!(
        (&done["verdict"], &done["round"], &done["findings"]),
        (&json!("Block"), &json!(2), &json!([]))
    );
    assert_eq!(
        (&done["base"], &done["lensScope"]),
        (&json!("origin/main"), &json!("delta"))
    );
    let rr = &done["reReview"];
    assert_eq!(
        (
            &rr["chained"],
            &rr["scope"],
            &rr["priorRound"],
            &rr["priorHead"]
        ),
        (&json!(true), &json!("fixes"), &json!(1), &json!(r1_head))
    );
    assert_eq!(
        (&rr["resolved"], &rr["stillOpen"], &rr["absorbed"]),
        (&json!(1), &json!(1), &json!(1))
    );
    let ledger: Vec<(&str, &str)> = done["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["ruleId"].as_str().unwrap(),
                r["disposition"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(ledger, [("RS-Y", "open"), ("RS-X", "closed")]);
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "This is round 2 of this branch, building on round 1",
            "1 resolved, 1 still open, 0 regressed",
            "- Resolved: **High** `src/lib.rs:1` — X: f returns 1",
            "- Still open: **High** `src/lib.rs:1` — Y: f has no error path\n  - Why: wrong — also reported at src/lib.rs:1: no error path in f — fix incomplete: f still has none",
            "## Confirmed findings\n\nNone.",
            "were absorbed into it (recorded on its rationale",
            "the re-review's adjudication in the same round of a deferred prior",
            "red team: 1 resolved Critical/High prior(s) attacked — 0 overturned (still open), 0 red team(s) died, 0 invalid",
        ],
    );
}

#[test]
fn fresh_starts_a_new_chain_over_the_whole_diff() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    round_one(repo.path(), &runs);
    fix(repo.path());
    let s = step::start(&StartOptions {
        fresh: true,
        ..at(repo.path(), &runs, "r2")
    })
    .unwrap();
    assert_eq!(ids(&s), ["scout-rust"], "nothing of round 1 is adjudicated");
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &["git diff --stat 'origin/main'...HEAD"],
    );
    let done = drive(&runs.join("r2"), s, &[], &[]);
    assert_eq!(done["round"], json!(1));
    assert_eq!(done["reReview"]["chained"], json!(false));
    assert!(
        done["reReview"]["reason"]
            .as_str()
            .unwrap()
            .starts_with("fresh"),
        "{}",
        done["reReview"]
    );
    // The next round builds on the fresh one, the newest, not on round 1.
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "more"]);
    let s = step::start(&at(repo.path(), &runs, "r3")).unwrap();
    assert_eq!(ids(&s), ["scout-rust"], "the fresh round left nothing open");
    let st = craft_review::status::status(&runs.join("r3")).unwrap();
    assert_eq!(st["round"], json!(2));
}

#[test]
fn every_full_every_th_round_reviews_the_whole_diff_again() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    round_one(repo.path(), &runs);
    fix(repo.path());
    let s = step::start(&StartOptions {
        full_every: 2,
        ..at(repo.path(), &runs, "r2")
    })
    .unwrap();
    assert_eq!(ids(&s), ["scout-rust", "adjudicate-0", "adjudicate-1"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &["git diff --stat 'origin/main'...HEAD"],
    );
    let s = submit(
        &runs.join("r2"),
        json!({
            "scout-rust": scout("small", &["errors"]),
            "adjudicate-0": {"status": "resolved", "currentLine": 0, "note": "", "invariant": "i", "attack": ""},
            "adjudicate-1": {"status": "resolved", "currentLine": 0, "note": "", "invariant": "i", "attack": ""},
        }),
    );
    assert_eq!(ids(&s), ["red-team-0", "red-team-1"]);
    let s = submit(
        &runs.join("r2"),
        json!({
            "red-team-0": {"defeated": false, "attack": ""},
            "red-team-1": {"defeated": false, "attack": ""},
        }),
    );
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            "--merge-base 'origin/main' -- '*.rs'",
            "RE-REVIEW (full re-scan): review the WHOLE diff (base origin/main...HEAD)",
        ],
    );
    let done = drive(&runs.join("r2"), s, &[], &[]);
    assert_eq!(done["verdict"], json!("Approve"));
    assert_eq!(done["reReview"]["scope"], json!("rescan"));
}

#[test]
fn a_round_with_no_fix_since_the_last_reviews_the_whole_diff_and_a_detached_head_chains_nothing() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    round_one(repo.path(), &runs);
    let s = step::start(&at(repo.path(), &runs, "r2")).unwrap();
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &["git diff --stat 'origin/main'...HEAD"],
    );
    let st = std::fs::read_to_string(runs.join("r2/state.json")).unwrap();
    assert!(
        st.contains("nothing changed since the prior round's head"),
        "{st}"
    );

    git(repo.path(), &["checkout", "-q", "--detach"]);
    let s = step::start(&at(repo.path(), &runs, "r3")).unwrap();
    assert_eq!(ids(&s), ["scout-rust"]);
    let st = std::fs::read_to_string(runs.join("r3/state.json")).unwrap();
    assert!(st.contains("no branch (a detached HEAD)"), "{st}");
}

#[test]
fn an_unchecked_site_keeps_one_ledger_row_across_full_rescans() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    // An Info: no verifier is spent on it, while a Low from the errors lens, a failure path, is.
    let mut low = found("RS-L", 2, "a low one");
    low["severity"] = json!("Info");
    for (round, name) in [(1, "r1"), (2, "r2"), (3, "r3")] {
        let s = step::start(&StartOptions {
            full_every: 1,
            ..at(repo.path(), &runs, name)
        })
        .unwrap();
        let done = drive(&runs.join(name), s, std::slice::from_ref(&low), &[]);
        assert_eq!(done["round"], json!(round));
        assert_eq!(
            done["reReview"]["scope"],
            json!(if round == 1 { "first" } else { "rescan" })
        );
        let rows: Vec<&Value> = done["ledger"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["ruleId"] == json!("RS-L"))
            .collect();
        assert_eq!(rows.len(), 1, "round {round}: {}", done["ledger"]);
        assert_eq!(rows[0]["tier"], json!("unverified"));
    }
}

#[test]
fn a_new_defect_under_the_rule_of_a_rejected_finding_is_not_swallowed() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    round_one(repo.path(), &runs);
    // The author rejects Y.
    let record = runs.join("r1/round.json");
    let mut r: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    r["ledger"][1]["disposition"] = json!("rejected");
    std::fs::write(&record, r.to_string()).unwrap();
    fix(repo.path());

    let s = step::start(&at(repo.path(), &runs, "r2")).unwrap();
    assert_eq!(ids(&s), ["scout-rust", "carry-1", "adjudicate-0"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][1]),
        &[
            "set aside by the author (disposition: rejected)",
            "rule RS-Y",
        ],
    );
    let r2 = runs.join("r2");
    let s = submit(
        &r2,
        json!({
            "scout-rust": scout("small", &["errors"]),
            "carry-1": {"changed": false, "reason": "untouched"},
            "adjudicate-0": {"status": "resolved", "currentLine": 1, "note": "", "invariant": "i", "attack": ""},
        }),
    );
    // A different defect under Y's rule, elsewhere in the file.
    let done = drive(&r2, s, &[found("RS-Y", 9, "another unwrap")], &[]);
    assert_eq!(done["verdict"], json!("Block"), "the new High gates");
    assert_eq!(done["findings"][0]["line"], json!(9));
    assert_eq!(done["reReview"]["retired"], json!(1));
    let ledger: Vec<(i64, &str)> = done["ledger"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["line"].as_i64().unwrap(),
                r["disposition"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(ledger, [(9, "open"), (1, "closed"), (1, "closed")]);
}

#[test]
fn a_red_team_that_breaks_a_resolved_high_reopens_it() {
    let repo = fixture(true);
    let (_keep, runs) = runs();
    round_one(repo.path(), &runs);
    fix(repo.path());
    let r2 = runs.join("r2");
    step::start(&at(repo.path(), &runs, "r2")).unwrap();
    let resolved = json!({"status": "resolved", "currentLine": 1, "note": "", "invariant": "f never returns 1", "attack": ""});
    let s = submit(
        &r2,
        json!({"scout-rust": scout("small", &["errors"]), "adjudicate-0": resolved, "adjudicate-1": resolved}),
    );
    assert_eq!(ids(&s), ["red-team-0", "red-team-1"]);
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &["INVARIANT it violated: f never returns 1"],
    );
    let s = submit(
        &r2,
        json!({
            "red-team-0": {"defeated": true, "attack": "f() under `cfg(test)` still returns 1"},
            "red-team-1": {"defeated": true, "attack": ""},
        }),
    );
    let done = drive(&r2, s, &[], &[]);
    assert_eq!(
        done["verdict"],
        json!("Block"),
        "the reopened High holds it"
    );
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert_contains_all(
        &report,
        &[
            "1 resolved, 1 still open, 0 regressed",
            "- Still open: **High** `src/lib.rs:1` — X: f returns 1\n  - Why: wrong — fix incomplete: (red-team) f() under cfg(test) still returns 1",
            "- Resolved: **High** `src/lib.rs:1` — Y: f has no error path",
            "the red team for src/lib.rs:1 claimed defeat with NO attack — invalid verdict discarded, keeping resolved",
            "red team: 2 resolved Critical/High prior(s) attacked — 1 overturned (still open), 0 red team(s) died, 1 invalid",
        ],
    );
}
