//! Unit mode end to end (realm @nick/craft, #324, #362): a change across two crates is cut into
//! unit batches, each sliceable lens runs confined to one, the contract lens runs on each crate, and
//! after the round a coordinator answers the lenses' questions — dropping or confirming the findings
//! that depend on them — and reports its own seam findings. A change the mode cannot slice runs in
//! the normal mode with a warning saying why; without the flag nothing changes.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

mod common;

use std::path::Path;

use common::{assert_contains_all, git, ids, lens, opts, prompt_of, scout, submit, verdict};
use craft_review::step::{self, StartOptions};
use serde_json::{Map, Value, json};

/// A body of `n` lines, so the numstat weighs each file.
fn body(n: usize) -> String {
    (0..n).map(|i| format!("pub fn f{i}() {{}}\n")).collect()
}

/// A workspace of `crates/a` (`core-a`) and `crates/b`, which depends on it, with `per_crate` files
/// of `lines` lines changed in each after `origin/main`.
fn workspace(per_crate: usize, lines: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    let write = |p: &str, text: &str| {
        let path = d.join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write(
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/a\", \"crates/b\"]\n",
    );
    write("crates/a/Cargo.toml", "[package]\nname = \"core-a\"\n");
    write(
        "crates/b/Cargo.toml",
        "[package]\nname = \"b\"\n[dependencies]\ncore-a = { path = \"../a\" }\n",
    );
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    for c in ["a", "b"] {
        for i in 0..per_crate {
            write(&format!("crates/{c}/src/f{i}.rs"), &body(lines));
        }
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f everywhere"]);
    dir
}

fn unit_opts(repo: &Path, out: &Path) -> StartOptions {
    StartOptions {
        unit_scope: true,
        ..opts(repo, out)
    }
}

fn task<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(id))
        .unwrap()
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

/// A finding of crate b's errors lens at `crates/b/src/f0.rs:<line>`.
fn in_b(title: &str, line: u32) -> Value {
    json!({
        "severity": "High", "title": title, "file": "crates/b/src/f0.rs", "line": line,
        "why": "wrong", "fix": "fix it", "blastRadius": "", "source": "errors", "ruleId": "", "whereChecked": "",
        "harmLevel": "intent-unmet", "harm": "callers break"
    })
}

/// A deferred question about crate a that `title`'s finding depends on.
fn question(title: &str) -> Value {
    json!({"unit": "crates/a", "symbol": "f0", "path": "crates/a/src/f0.rs", "ask": "does f0 close it?",
           "findingTitle": title, "findingFile": "crates/b/src/f0.rs", "blocking": false, "answered": false, "answer": ""})
}

/// Every pending task of `s` answered: a lens with nothing unless `answers` names it.
fn answer_all(s: &Value, answers: &Map<String, Value>) -> Value {
    let all: Map<String, Value> = ids(s)
        .into_iter()
        .map(|id| {
            let a = answers.get(&id).cloned().unwrap_or_else(|| {
                if id.starts_with("dedup-") {
                    json!({"groups": []})
                } else if id.starts_with("verify-") {
                    verdict(false)
                } else {
                    lens("x", &[])
                }
            });
            (id, a)
        })
        .collect();
    Value::Object(all)
}

#[test]
fn a_two_crate_change_is_sliced_judged_by_contract_and_seam_and_its_questions_decided() {
    let repo = workspace(7, 120);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&unit_opts(repo.path(), out.path())).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1-s0",
            "lens-rust-errors-r1-s1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1-s0",
            "lens-rust-tests-r1-s1",
            "lens-rust-contract-r1-u0",
            "lens-rust-contract-r1-u1",
        ]
    );
    let confined = task(&s, "lens-rust-errors-r1-s1");
    assert_eq!(
        confined["label"],
        json!("lens:rust:errors r1 unit:crates/b")
    );
    assert_contains_all(
        &prompt_of(confined),
        &[
            "CRATE SCOPE — this OVERRIDES",
            "you judge and READ the crate rooted at `crates/b/`",
            "':(literal)crates/b/src/f0.rs'",
            "Return {lens, findings[], questions[]}.",
        ],
    );
    assert!(!prompt_of(confined).contains("BLOCKING QUESTION"));
    assert_contains_all(
        &prompt_of(task(&s, "lens-rust-contract-r1-u0")),
        &[
            "the **contract** lens of a Rust review",
            "the crate at 'crates/a'",
        ],
    );
    assert!(!prompt_of(task(&s, "lens-rust-intent-r1")).contains("SCOPE —"));

    let (dropped, kept) = ("b leaks the handle a closes", "b ignores a's error");
    let mut found = Map::new();
    found.insert(
        "lens-rust-errors-r1-s1".into(),
        json!({"lens": "errors", "findings": [in_b(dropped, 1), in_b(kept, 2)], "questions": [question(dropped), question(kept)]}),
    );
    let s = submit(&run, answer_all(&s, &found));
    assert_eq!(ids(&s), ["seam-rust"]);
    assert_contains_all(
        &prompt_of(task(&s, "seam-rust")),
        &[
            "SEAM coordinator of a Rust review",
            "Touched crates: `crates/a`, `crates/b`",
            "\"findingTitle\":\"b leaks the handle a closes\"",
        ],
    );

    let mut seam = in_b("b calls a::f0 with a stale signature", 9);
    seam["file"] = json!("crates/b/src/f1.rs");
    let answer = json!({"answered": 2, "findings": [seam], "dispositions": [
        {"lens": "errors", "findingFile": "crates/b/src/f0.rs", "findingTitle": dropped, "action": "drop", "why": "a closes it on drop"},
        {"lens": "errors", "findingFile": "crates/b/src/f0.rs", "findingTitle": kept, "action": "confirm", "why": "a returns the error"}]});
    let mut s = submit(&run, json!({"seam-rust": answer}));
    while s["done"] == json!(false) {
        s = submit(&run, answer_all(&s, &Map::new()));
    }
    let text = report(&s);
    assert_contains_all(
        &text,
        &[
            "## Unit mode (unitScope)",
            "- rust: 2 slice(s): `unit:crates/a`",
            "the coordinator answered 2 question(s) of 2 asked, reported 1 seam finding(s), and of the dependent findings confirmed 1, dropped 1, converted 0",
            "## Set aside by the seam pass (unitScope)",
            "- drop · High · `crates/b/src/f0.rs:1` · errors · b leaks the handle a closes — a closes it on drop",
            "b ignores a's error",
            "b calls a::f0 with a stale signature",
        ],
    );
    assert!(!text.contains("unit slicing and the contract lens"));
}

#[test]
fn a_change_unit_mode_cannot_slice_runs_in_the_normal_mode_with_its_warning() {
    for (repo, why) in [
        (
            workspace(3, 5),
            "Unit mode skipped, change too small to slice: 6 files — the review ran in the normal mode.",
        ),
        (
            common::fixture(true),
            "Unit mode found no crate in the Rust change — the review ran in the normal mode.",
        ),
    ] {
        let out = tempfile::tempdir().unwrap();
        let run = out.path().join("run");
        step::start(&unit_opts(repo.path(), out.path())).unwrap();
        let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
        assert_eq!(
            ids(&s),
            [
                "lens-rust-errors-r1",
                "lens-rust-intent-r1",
                "lens-rust-tests-r1"
            ]
        );
        let mut s = submit(&run, answer_all(&s, &Map::new()));
        while s["done"] == json!(false) {
            s = submit(&run, answer_all(&s, &Map::new()));
        }
        assert_contains_all(
            &report(&s),
            &["## Unit mode (unitScope)", &format!("⚠️ {why}")],
        );
    }
}

#[test]
fn without_the_flag_a_two_crate_change_runs_as_before() {
    let repo = workspace(7, 120);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    let mut s = submit(&run, answer_all(&s, &Map::new()));
    while s["done"] == json!(false) {
        s = submit(&run, answer_all(&s, &Map::new()));
    }
    let text = report(&s);
    assert!(!text.contains("Unit mode"), "{text}");
    assert!(!text.contains("unit mode's choice"), "{text}");
}
