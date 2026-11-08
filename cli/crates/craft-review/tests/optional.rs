//! The optional pass (`optional`): off by default, a requested optional lens is planned and runs;
//! a name that is no optional lens is named in the report's notes.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::{fixture, ids, opts, scout, submit};
use craft_review::step::{self, StartOptions};
use serde_json::json;

/// The first lens round of a run asked for `optional`, its scout picking `errors` and `performance`.
fn first_round(optional: Option<&str>) -> (Vec<String>, tempfile::TempDir, tempfile::TempDir) {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    step::start(&StartOptions {
        optional: optional.map(str::to_owned),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let picks = scout("small", &["errors", "performance"]);
    let s = submit(&out.path().join("run"), json!({"scout-rust": picks}));
    (ids(&s), repo, out)
}

#[test]
fn a_requested_optional_lens_runs_and_an_unrequested_one_does_not() {
    let (without, _r, _o) = first_round(None);
    assert!(
        !without.iter().any(|id| id.contains("performance")),
        "{without:?}"
    );
    let (with, _r, _o) = first_round(Some("rust-performance"));
    assert!(
        with.contains(&"lens-rust-performance-r1".to_owned()),
        "{with:?}"
    );
    // Asked for, it runs whatever the scout picked.
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    step::start(&StartOptions {
        optional: Some("api-idioms".into()),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(
        &out.path().join("run"),
        json!({"scout-rust": scout("small", &["errors"])}),
    );
    assert!(ids(&s).contains(&"lens-rust-api-idioms-r1".to_owned()));
}

#[test]
fn a_name_that_is_no_optional_lens_is_noted() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    step::start(&StartOptions {
        optional: Some("perf".into()),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let state = std::fs::read_to_string(out.path().join("run/state.json")).unwrap();
    assert!(
        state.contains("names perf, which is not an optional lens"),
        "{state}"
    );
}
