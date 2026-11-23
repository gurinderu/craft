//! A run an earlier binary started and stopped mid-step is refused by this one, as any run of
//! another state format is: format 6, every craft before 0.59.0, whose metrics lenses read the code
//! graph's numbers themselves, holds none of the numbers this binary hands them (realm
//! @nick/craft, node #618). What the run's telemetry needs of its state still reads, so its
//! records are filed before the refusal.
//!
//! The fixture (`fixtures/old-run/state.json`) is a lens round's retry as the binary before the
//! step protocol moved into `craft-step` left it: written by the craft-review of commit 153b1a69,
//! through a throwaway test beside these that ran `common::small_run`, wrote `{}` for
//! `lens-rust-errors-r1` and the other lenses' clean answers, submitted once, and copied
//! `state.json` here, the run directory, the repository and the plugin root replaced by `@RUN@`,
//! `@REPO@` and `@ROOT@`. `EVERY_FIELD` is one task with each optional field set, in the field
//! order that commit's `Task` serialized, but for its `graph` flag, which no task carries any more:
//! a task that holds it still reads, the flag dropped.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture's files are the test's own: a missing one fails it loudly"
)]

mod common;

use std::path::Path;

use common::fixture;
use craft_review::{state, step};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/old-run");
const ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../integrations/claude-code"
);

const EVERY_FIELD: &str = r#"{
  "id": "lens-rust-complexity-r1",
  "label": "lens:rust:complexity r1",
  "prompt": "p",
  "model": "opus",
  "schema": {
    "type": "object"
  },
  "agentType": "rust-reviewer",
  "consumerAgent": "house-reviewer",
  "kind": "lens",
  "profile": "rust",
  "lens": "complexity",
  "round": 1,
  "slice": "crate-a",
  "consumers": [
    "src/a.rs:3",
    "src/b.rs:5"
  ],
  "unmarked": [
    "src/b.rs:5"
  ],
  "state": "failed",
  "retries": 2,
  "error": "e",
  "answer": {
    "findings": []
  },
  "refused": "r",
  "abandoned": true
}"#;

#[test]
fn a_task_with_every_field_set_reads_and_writes_back_byte_for_byte() {
    let task: state::Task = serde_json::from_str(EVERY_FIELD).unwrap();
    assert_eq!(serde_json::to_string_pretty(&task).unwrap(), EVERY_FIELD);
}

#[test]
fn a_task_with_the_retired_graph_flag_reads_and_writes_back_without_it() {
    let with = EVERY_FIELD.replace(
        "\"abandoned\": true\n",
        "\"abandoned\": true,\n  \"graph\": true\n",
    );
    assert!(with.contains("\"graph\": true"));
    let task: state::Task = serde_json::from_str(&with).unwrap();
    assert_eq!(serde_json::to_string_pretty(&task).unwrap(), EVERY_FIELD);
}

/// The fixture's state with its placeholders filled for this run.
fn filled(run: &Path, repo: &Path) -> String {
    std::fs::read_to_string(Path::new(FIXTURE).join("state.json"))
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
    std::fs::write(run.join("state.json"), filled(&run, &repo_path)).unwrap();
    (run, repo)
}

#[test]
fn an_earlier_binarys_state_is_refused_naming_its_format_and_how_to_start_anew() {
    let out = tempfile::tempdir().unwrap();
    let (run, _repo) = laid(out.path());
    let err = state::load(&run).unwrap_err().to_string();
    assert!(
        err.contains("a craft before 0.59.0 (format 6)")
            && err.contains("reads format 7 only")
            && err.contains("`craft review start`"),
        "{err}"
    );
    assert_eq!(
        state::phase_of(&run),
        Some(state::Phase::Lenses),
        "its phase still reads, for filing its records"
    );
}

#[test]
fn a_submit_over_an_earlier_binarys_run_is_refused_and_writes_nothing() {
    let out = tempfile::tempdir().unwrap();
    let (run, _repo) = laid(out.path());
    std::fs::write(run.join("answers/lens-rust-errors-r1.json"), "{}").unwrap();
    let before = std::fs::read_to_string(run.join("state.json")).unwrap();
    let err = step::submit(&run, None).unwrap_err().to_string();
    assert!(err.contains("format 6"), "{err}");
    assert_eq!(
        std::fs::read_to_string(run.join("state.json")).unwrap(),
        before
    );
    assert!(!run.join("tasks").exists(), "no task handed out");
}
