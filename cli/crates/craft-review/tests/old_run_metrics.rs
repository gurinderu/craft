//! A run an earlier binary started whose plan runs a metrics lens is refused, not resumed: before
//! 0.59.0 the complexity lens and its verifier read the code graph's numbers over its MCP tools, so
//! the state holds none of the numbers this binary hands them in their prompt — its verifier would
//! refute every metric finding, and its stored tasks ask for tools the lean task agent lacks.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture's files are the test's own: a missing one fails it loudly"
)]

mod common;

use std::path::Path;

use craft_review::step;
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/old-run/state.json"
);
const ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../integrations/claude-code"
);

/// The fixture's run in `out/run` over a fresh repository, `edit` applied to its state first.
fn laid(out: &Path, edit: impl Fn(&mut Value)) -> (std::path::PathBuf, tempfile::TempDir) {
    let repo = common::fixture(true);
    let run = out.join("run");
    std::fs::create_dir_all(run.join("answers")).unwrap();
    let text = std::fs::read_to_string(FIXTURE)
        .unwrap()
        .replace("@RUN@", &run.display().to_string())
        .replace(
            "@REPO@",
            &repo.path().canonicalize().unwrap().display().to_string(),
        )
        .replace("@ROOT@", ROOT);
    let mut state: Value = serde_json::from_str(&text).unwrap();
    edit(&mut state);
    std::fs::write(run.join("state.json"), state.to_string()).unwrap();
    (run, repo)
}

#[test]
fn an_earlier_binarys_run_with_a_graph_flagged_metrics_lens_is_refused_saying_how_to_start_fresh() {
    let out = tempfile::tempdir().unwrap();
    let (run, _repo) = laid(out.path(), |s| {
        s["tracks"][0]["plan"]["lenses"]
            .as_array_mut()
            .unwrap()
            .push(json!("complexity"));
        let mut metrics = s["tasks"][0].clone();
        metrics["id"] = json!("lens-rust-complexity-r1");
        metrics["label"] = json!("lens:rust:complexity r1");
        metrics["lens"] = json!("complexity");
        metrics["prompt"] = json!("Use ToolSearch to load the codebase-memory MCP tools.");
        metrics["graph"] = json!(true);
        s["tasks"].as_array_mut().unwrap().push(metrics);
    });
    let before = std::fs::read_to_string(run.join("state.json")).unwrap();
    let err = step::submit(&run, None).unwrap_err().to_string();
    assert!(
        err.contains("before 0.59.0") && err.contains("craft review start"),
        "{err}"
    );
    assert_eq!(
        std::fs::read_to_string(run.join("state.json")).unwrap(),
        before,
        "nothing written"
    );
}

#[test]
fn an_earlier_binarys_run_whose_plan_runs_no_metrics_lens_goes_on() {
    let out = tempfile::tempdir().unwrap();
    let (run, _repo) = laid(out.path(), |_| {});
    std::fs::write(run.join("answers/lens-rust-errors-r1.json"), "{}").unwrap();
    assert!(step::submit(&run, None).is_ok());
}
