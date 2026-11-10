//! Where an entry's command must run (realm @nick/craft, node #482): not in a step or job that
//! continues on error, not in a source's comment lines, and in a job its check names — a check
//! naming no job of its workflow is refused.

use super::CiEntry;
use super::ci_match_tests::{CLIPPY, WF, entry, top};

#[test]
fn a_step_or_job_that_continues_on_error_does_not_ground() {
    let step = format!(
        "jobs:\n  lint:\n    steps:\n      - run: {CLIPPY}\n        continue-on-error: true\n"
    );
    let job = format!(
        "jobs:\n  lint:\n    continue-on-error: ${{{{ matrix.experimental }}}}\n    steps:\n      - run: {CLIPPY}\n"
    );
    for wf in [step, job] {
        let t = top(&wf, "");
        CiEntry::confirmed(&entry("lint", "clippy", CLIPPY, "[]"), t.path()).unwrap_err();
    }
    let kept = format!(
        "jobs:\n  lint:\n    steps:\n      - run: {CLIPPY}\n        continue-on-error: false\n"
    );
    let t = top(&kept, "");
    CiEntry::confirmed(&entry("lint", "clippy", CLIPPY, "[]"), t.path()).unwrap();
}

#[test]
fn a_sources_comment_lines_spell_nothing() {
    let wf = "jobs:\n  lint:\n    steps:\n      - run: just lint\n";
    let given = entry("lint", "clippy", CLIPPY, r#"["justfile"]"#);
    for (recipe, ok) in [
        (
            "lint:\n    # cargo clippy -- -D warnings\n    true\n",
            false,
        ),
        ("lint:\n    true # cargo clippy -- -D warnings\n", false),
        ("lint:\n    -cargo clippy -- -D warnings\n", false),
        ("lint:\n    @cargo clippy -- -D warnings\n", true),
    ] {
        let t = top(wf, recipe);
        assert_eq!(CiEntry::confirmed(&given, t.path()).is_ok(), ok, "{recipe}");
    }
}

#[test]
fn a_check_naming_no_job_of_its_workflow_is_refused() {
    let wf = format!("jobs:\n  lint:\n    steps:\n      - run: {CLIPPY}\n");
    let t = top(&wf, "");
    let err = CiEntry::confirmed(&entry("Lint all", "clippy", CLIPPY, "[]"), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("matches no job") && err.contains(WF), "{err}");
    let matrix = format!(
        "jobs:\n  lint:\n    name: Lint\n    strategy:\n      matrix:\n        os: [a, b]\n    steps:\n      - run: {CLIPPY}\n"
    );
    let t = top(&matrix, "");
    CiEntry::confirmed(&entry("Lint", "clippy", CLIPPY, "[]"), t.path()).unwrap();
    let one = CiEntry::confirmed(&entry("Lint (a, b)", "clippy", CLIPPY, "[]"), t.path())
        .unwrap_err()
        .to_string();
    assert!(one.contains("name the check `Lint`"), "{one}");
    CiEntry::confirmed(&entry("lint", "clippy", CLIPPY, "[]"), t.path()).unwrap_err();
}
