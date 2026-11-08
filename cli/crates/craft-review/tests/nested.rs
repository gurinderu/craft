//! A run a parent engine launched (`nested`, rust-audit's per-crate reviews) stays out of the
//! branch's chain of rounds: it builds on no earlier round and files none, so a second nested run
//! of the same path is a first, whole review again.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{fixture, ids, lens, opts, scout, submit};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// Answers every task until the run is done: a small plan, no lens finding.
fn drive(run: &Path, mut s: Value) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if id.starts_with("dedup-") {
                json!({"groups": []})
            } else {
                let name = id.strip_prefix("lens-rust-").unwrap();
                lens(name.split('-').next().unwrap(), &[])
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

/// A run of `repo` in `<runs>/<name>`, scoped to `src`, nested or not.
fn run(repo: &Path, runs: &Path, name: &str, nested: bool) -> Value {
    let dir = runs.join(name);
    let s = step::start(&StartOptions {
        run_dir: dir.clone(),
        path: Some("src".into()),
        nested,
        ..opts(repo, runs)
    })
    .unwrap();
    drive(&dir, s)
}

#[test]
fn nested_runs_of_one_path_are_each_a_first_whole_review() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    for name in ["n1", "n2"] {
        let done = run(repo.path(), runs.path(), name, true);
        assert_eq!(
            (
                &done["round"],
                &done["lensScope"],
                &done["reReview"]["chained"]
            ),
            (&json!(1), &json!("full"), &json!(false)),
            "{name}: {done}"
        );
        assert!(
            !runs.path().join(name).join("round.json").exists(),
            "{name} files no round"
        );
    }
    // A run of the branch's own chain still files its round, and a nested run does not build on it.
    run(repo.path(), runs.path(), "own", false);
    assert!(runs.path().join("own/round.json").exists());
    let done = run(repo.path(), runs.path(), "n3", true);
    assert_eq!(done["round"], json!(1), "{done}");
}
