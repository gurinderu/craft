//! What a run records of where it started, what it refuses to start over, and the harm cap on its
//! verdict.

mod common;

use common::{finding, fixture, git, ids, lens, opts, small_run, submit, verdict};
use craft_review::Error;
use craft_review::step::{self, StepError};
use serde_json::json;

#[test]
fn a_run_dir_with_leftover_tasks_or_answers_is_refused() {
    let repo = fixture(true);
    for sub in ["tasks", "answers"] {
        let out = tempfile::tempdir().unwrap();
        let left = out.path().join("run").join(sub);
        std::fs::create_dir_all(&left).unwrap();
        std::fs::write(left.join("verify-0.json"), "{}").unwrap();
        let err = step::start(&opts(repo.path(), out.path())).unwrap_err();
        assert!(
            matches!(&err, Error::Step(StepError::Leftovers(d)) if d.ends_with(sub)),
            "{err}"
        );
        assert!(
            err.to_string().ends_with("holds files of another run"),
            "{err}"
        );
        assert!(!out.path().join("run/state.json").exists());
    }
    let out = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(out.path().join("run/answers")).unwrap();
    step::start(&opts(repo.path(), out.path())).unwrap();
}

#[test]
fn the_report_and_state_name_the_head_and_whether_the_tree_was_dirty() {
    let repo = fixture(false);
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let head = String::from_utf8(head.stdout).unwrap().trim().to_owned();
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains(&format!("Head `{head}`, clean tree;")),
        "{report}"
    );
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(out.path().join("run/state.json")).unwrap())
            .unwrap();
    assert_eq!(
        (&state["diff"]["head"], &state["diff"]["dirty"]),
        (&json!(head), &json!(false))
    );

    std::fs::write(repo.path().join("src/notes.txt"), "changed\n").unwrap();
    std::fs::write(repo.path().join("untracked.txt"), "x\n").unwrap();
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("with uncommitted changes;"), "{report}");
    git(repo.path(), &["checkout", "--", "src/notes.txt"]);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("clean tree;"),
        "an untracked file alone is not dirty: {report}"
    );
}

#[test]
fn a_confirmed_high_naming_a_self_healing_harm_is_capped_and_does_not_block() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let mut f = finding("High", 1);
    f["harmLevel"] = json!("self-healing");
    let s = submit(
        &run,
        json!({"lens-errors-r1": lens("errors", &[]), "lens-intent-r1": lens("intent", &[f]), "lens-tests-r1": lens("tests", &[])}),
    );
    assert_eq!(
        ids(&s),
        ["verify-0-v0", "verify-0-v1"],
        "one finding needs no dedup; a High opens with a cull and the authoritative vote"
    );
    let s = submit(
        &run,
        json!({"verify-0-v0": verdict(false), "verify-0-v1": verdict(false)}),
    );
    assert_eq!(s["verdict"], json!("Approve"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("**Low** `src/lib.rs:1`"), "{report}");
    assert!(
        report.contains("harm cap — harm level self-healing allows at most Low"),
        "{report}"
    );
}

/// Starts a run over a repository whose only change is `name` (none when empty), and returns its
/// verdict and report.
fn exit_of(name: &str, base: Option<&str>) -> (serde_json::Value, String) {
    let (s, report) = start_with(name, base);
    (s.get("verdict").cloned().unwrap_or_default(), report)
}

/// The step `start` prints over a repository whose only change is `name`.
fn start_over(name: &str) -> serde_json::Value {
    start_with(name, None).0
}

/// The step `start` prints over a repository whose only change is `name` (none when empty), and
/// its report, read before the run directory goes.
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a step of the tests, failing loudly like them"
)]
fn start_with(name: &str, base: Option<&str>) -> (serde_json::Value, String) {
    let repo = fixture(true);
    let d = repo.path();
    if name.is_empty() {
        git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    } else {
        git(d, &["rm", "-q", "src/lib.rs"]);
        git(d, &["commit", "-qm", "drop lib"]);
        git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        std::fs::write(d.join(name), "x\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "add one file"]);
    }
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(d, out.path());
    o.base = base.map(str::to_owned);
    let s = step::start(&o).unwrap();
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    (s, report)
}

#[test]
fn a_diff_the_rust_profile_covers_nothing_of_takes_the_engines_coverage_exit() {
    let (v, report) = exit_of("main.py", None);
    assert_eq!(v, json!("INCOMPLETE (no language profile)"));
    assert!(
        report.contains("## Verdict\n\n⚠️ INCOMPLETE — NOTHING WAS REVIEWED — none of the 1 changed file(s) match a supported language profile (this engine reviews Rust only), and 1 of them carry reviewable content"),
        "{report}"
    );
    assert!(
        report.contains("## Not reviewed (no language profile)\n\n- main.py"),
        "{report}"
    );

    let s = start_over("main.py");
    assert_eq!(s["uncovered"], json!(["main.py"]));
    let line = s["line"].as_str().unwrap();
    assert!(
        line.starts_with("⚠️ INCOMPLETE — NOTHING WAS REVIEWED — none of the 1 changed file(s) match a supported language profile"),
        "the finished step says why nothing was reviewed, not a bare INCOMPLETE: {line}"
    );

    let (v, report) = exit_of("NOTES.md", None);
    assert_eq!(v, json!("Approve (nothing to review)"));
    assert!(
        report.contains(
            "✅ Approve (NOTHING TO REVIEW) — NOTHING NEEDED REVIEWING — all 1 changed file(s)"
        ),
        "{report}"
    );

    let (v, report) = exit_of("", None);
    assert_eq!(v, json!("INCOMPLETE (empty diff)"));
    assert!(report.contains("HEAD IS the resolved base"), "{report}");
    let (_, report) = exit_of("", Some("origin/main"));
    assert!(report.contains("the diff came back EMPTY"), "{report}");
}

/// A small run over `src/lib.rs` changed beside `extra`, ended by a round with no finding: its
/// finished step and report.
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a step of the test below, failing loudly like it"
)]
fn mixed_run(extra: &[&str]) -> (serde_json::Value, String) {
    let repo = fixture(true);
    for name in extra {
        std::fs::write(repo.path().join(name), "x\n").unwrap();
    }
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "add the rest"]);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let s = submit(
        &run,
        json!({"lens-errors-r1": lens("errors", &[]), "lens-intent-r1": lens("intent", &[]), "lens-tests-r1": lens("tests", &[])}),
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    (s, report)
}

#[test]
fn changed_code_no_profile_covers_is_listed_and_marks_the_verdict_partial_coverage() {
    let (s, report) = mixed_run(&["app.py", "Makefile", "NOTES.md"]);
    assert_eq!(s["verdict"], json!("Approve (PARTIAL COVERAGE)"));
    assert_eq!(
        s["uncovered"],
        json!(["Makefile", "app.py"]),
        "the uncovered files carrying something to review, config included, the inert left out"
    );
    let line = "Approve (PARTIAL COVERAGE) — 1 changed file(s) matched no language profile and were NOT reviewed (app.py): this verdict covers only the files the Rust profile reviewed";
    assert_eq!(s["line"], json!(line));
    assert!(
        report.contains(&format!("## Verdict\n\n{line}\n")),
        "{report}"
    );
    assert!(
        report.contains("## Not reviewed (no language profile)\n\n- Makefile\n- app.py\n"),
        "{report}"
    );

    let (s, report) = mixed_run(&["Makefile"]);
    assert_eq!(
        (&s["verdict"], &s["line"]),
        (&json!("Approve"), &json!("Approve")),
        "project configuration is listed, but no hole in the review of the code"
    );
    assert!(
        report.contains("## Not reviewed (no language profile)\n\n- Makefile\n"),
        "{report}"
    );
}
