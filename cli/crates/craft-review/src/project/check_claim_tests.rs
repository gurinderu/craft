//! What a check claims among its workflow's jobs (realm @nick/craft, node #482): the gate counts
//! every run named `<check>` or `<check> (…)`, so a sibling job reported so collides, and a check
//! naming one expanded run of a job never sees the others.

use super::CiEntry;
use super::candidates::{Candidate, candidates_in};
use super::ci_files::hashes;

const WF: &str = ".github/workflows/ci.yml";
const BUILD: &str = "jobs:\n  build:\n    name: Build (${{ matrix.arch }})\n    strategy:\n      matrix:\n        arch: [amd64, arm64]\n    steps:\n      - run: cargo build --locked\n";

fn with(sibling: &str, run: &str) -> String {
    format!("{BUILD}  other:\n    name: {sibling}\n    steps:\n      - run: {run}\n")
}

fn top(workflow: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), workflow).unwrap();
    dir
}

fn fresh(check: &str) -> String {
    format!(
        r#"{{"check":"{check}","signal":"build","command":"cargo build --locked","workflow":"{WF}"}}"#
    )
}

/// The held form of `check`'s entry, hashed over the workflow as it is now.
fn held(check: &str, t: &tempfile::TempDir) -> String {
    let h = serde_json::to_string(&hashes(t.path(), WF, &[WF]).unwrap()).unwrap();
    format!(
        r#"{{"check":"{check}","signal":"build","command":"cargo build --locked","workflow":"{WF}","hashes":{h}}}"#
    )
}

fn refused(json: &str, t: &tempfile::TempDir) -> String {
    CiEntry::confirmed(json, t.path()).unwrap_err().to_string()
}

#[test]
fn a_literal_sibling_reported_as_the_check_s_matrix_run_is_refused_fresh_or_held() {
    let t = top(&with("Build (docs)", "mdbook build"));
    for err in [
        refused(&fresh("Build"), &t),
        refused(&held("Build", &t), &t),
    ] {
        assert!(
            err.contains("\"Build (docs)\"") && err.contains("Build (…)"),
            "{err}"
        );
    }
}

#[test]
fn a_sibling_whose_literal_head_is_the_check_s_matrix_run_is_refused() {
    let t = top(&with("Build (${{ matrix.x }}) docs", "mdbook build"));
    assert!(refused(&fresh("Build"), &t).contains("Build (${{ matrix.x }}) docs"));
}

#[test]
fn an_expression_sibling_with_the_same_prefix_must_run_the_command_itself() {
    let t = top(&with("Build (${{ matrix.os }})", "make docs"));
    let err = refused(&fresh("Build"), &t);
    assert!(
        err.contains("Build (${{ matrix.os }})") && err.contains("run:"),
        "{err}"
    );
    let t = top(&with("Build (${{ matrix.os }})", "cargo build --locked"));
    CiEntry::confirmed(&fresh("Build"), t.path()).unwrap();
}

#[test]
fn an_unrelated_sibling_is_no_collision() {
    let t = top(&with("Build docs", "mdbook build"));
    CiEntry::confirmed(&fresh("Build"), t.path()).unwrap();
}

#[test]
fn a_check_naming_one_expanded_run_is_refused_with_its_prefix() {
    let t = top(BUILD);
    let err = refused(&fresh("Build (amd64)"), &t);
    assert!(
        err.contains("one expanded run") && err.contains("`Build`"),
        "{err}"
    );
}

#[test]
fn a_colliding_candidate_is_proposed_unresolved_with_a_note() {
    let got = candidates_in(WF, &with("Build (docs)", "cargo doc --no-deps"));
    assert!(
        !got.iter()
            .any(|c| matches!(c, Candidate::Resolved(r) if r.check == "Build")),
        "{got:?}"
    );
    let note = got.iter().find_map(|c| match c {
        Candidate::Unresolved(u) if u.check == "Build" => u.note.clone(),
        Candidate::Unresolved(_) | Candidate::Resolved(_) => None,
    });
    assert!(
        note.as_deref()
            .is_some_and(|n| n.contains("\"Build (docs)\"")),
        "{got:?}"
    );
}
