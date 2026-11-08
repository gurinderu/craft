//! A review of one directory of the change (`path`), as a rust-audit reviews each crate: only that
//! crate's files are reviewed, the scout is told the scope, the lenses read only its files, and
//! its round chain is its own.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{assert_contains_all, git, ids, lens, opts, prompt_of, scout, submit};
use craft_review::step::{self, StartOptions};
use craft_review::{Error, status};
use serde_json::{Value, json};

/// A repository whose `origin/main` is its first commit, with two crates changed after it.
fn two_crates() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    for c in ["a", "b"] {
        std::fs::create_dir_all(d.join(format!("crates/{c}/src"))).unwrap();
        std::fs::write(
            d.join(format!("crates/{c}/src/lib.rs")),
            "pub fn f() -> u8 { 1 }\n",
        )
        .unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: two crates"]);
    dir
}

/// The options of a run in `<out>/<name>` over `path`.
fn scoped(repo: &Path, out: &Path, name: &str, path: &str) -> StartOptions {
    StartOptions {
        run_dir: out.join(name),
        path: Some(path.into()),
        ..opts(repo, out)
    }
}

/// Answers every task until the run is done: a small plan, lenses that find nothing.
fn drive(run: &Path, mut s: Value) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else {
                let name = id.strip_prefix("lens-rust-").unwrap().split('-').next();
                lens(name.unwrap(), &[])
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

#[test]
fn a_path_reviews_only_that_crate() {
    let repo = two_crates();
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&scoped(repo.path(), out.path(), "a", "crates/a")).unwrap();
    let run = out.path().join("a");
    assert_eq!(status::status(&run).unwrap()["files"], json!(1));
    assert_contains_all(
        &prompt_of(&s["tasks"][0]),
        &[
            "SCOPE: review ONLY the crate/dir at `crates/a`. Pass `-- 'crates/a'` to every `git diff` command below.",
        ],
    );
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let p = prompt_of(&s["tasks"][0]);
    assert_contains_all(&p, &["-- ':(literal)crates/a/src/lib.rs'`"]);
    assert!(
        !p.contains("'*.rs'") && !p.contains("crates/b"),
        "the lens reads only the scope's files: {p}"
    );
    let done = drive(&run, s);
    assert_eq!(done["verdict"], json!("Approve"), "{done}");
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("1 changed file(s) under `crates/a`, 1 Rust."),
        "{report}"
    );
}

#[test]
fn an_absolute_path_inside_the_repository_is_its_directory_and_one_outside_is_refused() {
    let repo = two_crates();
    let out = tempfile::tempdir().unwrap();
    let inside = repo.path().join("crates/b").display().to_string();
    step::start(&scoped(repo.path(), out.path(), "b", &inside)).unwrap();
    let st = status::status(&out.path().join("b")).unwrap();
    assert_eq!(st["files"], json!(1));
    let refused = step::start(&scoped(repo.path(), out.path(), "x", "/elsewhere")).unwrap_err();
    assert!(matches!(refused, Error::Step(_)), "{refused}");
    assert!(
        refused.to_string().contains("not inside the repository"),
        "{refused}"
    );
}

#[test]
fn a_scoped_round_builds_only_on_a_round_of_the_same_scope() {
    let repo = two_crates();
    let out = tempfile::tempdir().unwrap();
    let first = step::start(&scoped(repo.path(), out.path(), "a1", "crates/a")).unwrap();
    drive(&out.path().join("a1"), first);
    let other = step::start(&scoped(repo.path(), out.path(), "b1", "crates/b")).unwrap();
    let other = drive(&out.path().join("b1"), other);
    assert_eq!(other["reReview"]["chained"], json!(false), "{other}");
    let again = step::start(&scoped(repo.path(), out.path(), "a2", "crates/a")).unwrap();
    let again = drive(&out.path().join("a2"), again);
    assert_eq!(
        (&again["reReview"]["chained"], &again["round"]),
        (&json!(true), &json!(2)),
        "{again}"
    );
    let whole = step::start(&StartOptions {
        run_dir: out.path().join("w1"),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let whole = drive(&out.path().join("w1"), whole);
    assert_eq!(whole["reReview"]["chained"], json!(false), "{whole}");
}
