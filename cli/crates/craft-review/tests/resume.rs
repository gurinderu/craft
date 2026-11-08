//! A stopped run is resumed only over the tree it started on: a new commit or an edited tracked
//! file since refuses the resume, and the run stays as it stopped; an unchanged tree goes on. A
//! late-resumed run's round does not pass for the newest one of its branch.
mod common;

use std::path::Path;

use common::{fixture, git, ids, small_run};
use craft_review::chain::{self, Key};
use craft_review::status;
use craft_review::step::{self, Said};
use serde_json::json;

/// Stops the run in `run` on the account's limit.
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test helper fails the test loudly, like the tests it serves"
)]
fn stop_on_limit(run: &Path) {
    let said = Said {
        limit: Some("You've hit your limit"),
        ..Said::default()
    };
    let s = step::submit_with(run, None, &said).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"), "{s}");
}

fn resume(run: &Path) -> Result<serde_json::Value, craft_review::Error> {
    let said = Said {
        resume: true,
        ..Said::default()
    };
    step::submit_with(run, None, &said)
}

#[test]
fn a_resume_after_a_new_commit_is_refused_and_the_run_stays_stopped() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    stop_on_limit(&run);
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f"]);

    let why = resume(&run).unwrap_err().to_string();
    assert!(
        why.starts_with("HEAD moved since this run stopped ("),
        "{why}"
    );
    assert!(why.ends_with("); start a new review"), "{why}");
    let plain = step::submit(&run, None).unwrap_err().to_string();
    assert_eq!(
        plain, why,
        "a plain submit of the stopped run is refused alike"
    );
    let st = status::status(&run).unwrap();
    assert_eq!(st["done"], json!(false), "the run is not continued: {st}");
}

#[test]
fn a_resume_after_an_edit_of_a_tracked_file_is_refused() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    stop_on_limit(&run);
    std::fs::write(repo.path().join("README.md"), "edited\n").unwrap();

    let why = resume(&run).unwrap_err().to_string();
    assert!(
        why.starts_with("tracked files changed since this run stopped (HEAD "),
        "{why}"
    );
}

#[test]
fn a_resume_over_the_unchanged_tree_goes_on() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    stop_on_limit(&run);
    // An untracked file is no change the review read.
    std::fs::write(repo.path().join("scratch.txt"), "x\n").unwrap();

    let s = resume(&run).unwrap();
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ],
        "the held round is handed out again: {s}"
    );
}

#[test]
fn the_round_of_the_run_started_last_is_the_newest_however_late_another_was_filed() {
    let repo = fixture(true);
    let runs = tempfile::tempdir().unwrap();
    let d = repo.path();
    let common = craft_review::git::common_dir(d).unwrap();
    let head = String::from_utf8(
        std::process::Command::new("git")
            .args(["-C", &d.display().to_string(), "rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    // `early` started first and was resumed late, filed after `later`, which started after it.
    for (name, round, started, finished) in [("early", 1, 100, 900), ("later", 2, 200, 300)] {
        let mut r = chain::record(&common, "main", head.trim(), round, Vec::new());
        (r.started_at_ms, r.finished_at_ms) = (started, finished);
        let dir = runs.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        chain::file_record(&dir, &r).unwrap();
    }
    let key = Key {
        repo: &common,
        branch: "main",
        scope: "",
    };
    let newest = chain::newest(runs.path(), d, key).unwrap();
    assert_eq!(newest.record.round, 2, "{newest:?}");
}
