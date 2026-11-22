//! A run an earlier binary started and stopped mid-step goes on under this one: its state file
//! reads and writes back byte for byte, and a submit over it hands out the same step and the same
//! task files that binary wrote. The fixture (`fixtures/old-run`) is a lens round's retry as the
//! binary before the step protocol moved into `craft-step` left it, its paths as placeholders.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture's files are the test's own: a missing one fails it loudly"
)]

mod common;

use std::path::Path;

use common::{fixture, lens};
use craft_review::{state, step};
use serde_json::Value;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/old-run");
const ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../integrations/claude-code"
);

/// A fixture file with its placeholders filled for this run.
fn filled(name: &str, run: &Path, repo: &Path) -> String {
    std::fs::read_to_string(Path::new(FIXTURE).join(name))
        .unwrap()
        .replace("@RUN@", &run.display().to_string())
        .replace("@REPO@", &repo.display().to_string())
        .replace("@ROOT@", ROOT)
}

/// The fixture's run laid out in `out/run`, over a fresh repository like the one it reviewed.
fn laid(out: &Path) -> (std::path::PathBuf, tempfile::TempDir) {
    let repo = fixture(true);
    let repo_path = repo.path().canonicalize().unwrap();
    let run = out.join("run");
    std::fs::create_dir_all(run.join("answers")).unwrap();
    std::fs::write(
        run.join("state.json"),
        filled("state.json", &run, &repo_path),
    )
    .unwrap();
    (run, repo)
}

#[test]
fn an_earlier_binarys_state_reads_and_writes_back_byte_for_byte() {
    let out = tempfile::tempdir().unwrap();
    let (run, _repo) = laid(out.path());
    let before = std::fs::read_to_string(run.join("state.json")).unwrap();
    let read = state::load(&run).unwrap();
    state::save(&run, &read).unwrap();
    assert_eq!(
        std::fs::read_to_string(run.join("state.json")).unwrap(),
        before
    );
}

#[test]
fn an_earlier_binarys_run_hands_out_the_same_step_and_goes_on() {
    let out = tempfile::tempdir().unwrap();
    let (run, repo) = laid(out.path());
    let repo_path = repo.path().canonicalize().unwrap();
    let answer = run.join("answers/lens-rust-errors-r1.json");
    // The same refused answer again: the retry it hands out is the one that binary wrote.
    std::fs::write(&answer, "{}").unwrap();
    let s = step::submit(&run, None).unwrap();
    let want: Value = serde_json::from_str(&filled("step.json", &run, &repo_path)).unwrap();
    assert_eq!(s, want);
    for (file, fixture) in [
        ("lens-rust-errors-r1.md", "task-lens-rust-errors-r1.md"),
        (
            "lens-rust-errors-r1.schema.json",
            "task-lens-rust-errors-r1.schema.json",
        ),
    ] {
        assert_eq!(
            std::fs::read_to_string(run.join("tasks").join(file)).unwrap(),
            filled(fixture, &run, &repo_path),
            "{file}"
        );
    }
    assert!(
        run.join("answers/lens-rust-errors-r1.rejected-1.json")
            .is_file()
    );
    // A valid answer now: the lens round is whole, found nothing, and the run finishes.
    std::fs::write(&answer, lens("errors", &[]).to_string()).unwrap();
    let s = step::submit(&run, None).unwrap();
    assert_eq!(s["done"], Value::Bool(true), "{s}");
    assert!(s["verdict"].is_string(), "{s}");
}
