//! What a check claims across the repository's workflows (realm @nick/craft, node #482): the gate
//! counts runs named `<check>` or `<check> (…)` from every workflow on the head, so a sibling in
//! another workflow collides; a plain matrix job's runs are `<name> (…)`, so naming one is one run;
//! and only the jobs that could report as the check decide which refusal it gets.

use super::CiEntry;
use super::ci_files::hashes;

const WF: &str = ".github/workflows/ci.yml";
const DOCS: &str = ".github/workflows/docs.yml";
const TEST: &str = "jobs:\n  tests:\n    steps:\n      - run: cargo test --locked\n";

fn top(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    for (path, text) in files {
        std::fs::write(dir.path().join(path), text).unwrap();
    }
    dir
}

fn entry(check: &str, command: &str) -> String {
    format!(r#"{{"check":"{check}","signal":"test","command":"{command}","workflow":"{WF}"}}"#)
}

fn refused(json: &str, t: &tempfile::TempDir) -> String {
    CiEntry::confirmed(json, t.path()).unwrap_err().to_string()
}

#[test]
fn a_sibling_in_another_workflow_is_refused_fresh_or_held() {
    let docs = "jobs:\n  docs:\n    name: tests (docs)\n    steps:\n      - run: mdbook test\n";
    let t = top(&[(WF, TEST), (DOCS, docs)]);
    let h = serde_json::to_string(&hashes(t.path(), WF, &[WF]).unwrap()).unwrap();
    let held = format!(
        r#"{{"check":"tests","signal":"test","command":"cargo test --locked","workflow":"{WF}","hashes":{h}}}"#
    );
    for err in [
        refused(&entry("tests", "cargo test --locked"), &t),
        refused(&held, &t),
    ] {
        assert!(
            err.contains("\"tests (docs)\"") && err.contains(DOCS),
            "{err}"
        );
    }
}

#[test]
fn a_same_named_job_in_another_workflow_that_runs_other_commands_is_refused() {
    let docs = "jobs:\n  tests:\n    steps:\n      - run: mdbook test\n";
    let t = top(&[(WF, TEST), (DOCS, docs)]);
    let err = refused(&entry("tests", "cargo test --locked"), &t);
    assert!(err.contains(DOCS) && err.contains("run:"), "{err}");
}

#[test]
fn a_check_naming_one_run_of_a_plain_matrix_job_is_refused_with_its_name() {
    let wf = "jobs:\n  tests:\n    name: Test\n    strategy:\n      matrix:\n        os: [a, b]\n    steps:\n      - run: cargo test --locked\n";
    let t = top(&[(WF, wf)]);
    let err = refused(&entry("Test (a)", "cargo test --locked"), &t);
    assert!(
        err.contains("one expanded run") && err.contains("name the check `Test`"),
        "{err}"
    );
}

#[test]
fn a_literal_job_beside_an_expression_job_of_its_prefix_collides_rather_than_one_run() {
    let wf = "jobs:\n  build:\n    name: Build (${{ matrix.arch }})\n    strategy:\n      matrix:\n        arch: [amd64]\n    steps:\n      - run: cargo build --locked\n  docs:\n    name: Build (docs)\n    steps:\n      - run: cargo test --locked\n";
    let t = top(&[(WF, wf)]);
    let err = refused(&entry("Build (docs)", "cargo test --locked"), &t);
    assert!(
        !err.contains("name the check") && err.contains("Build (${{ matrix.arch }})"),
        "{err}"
    );
}
