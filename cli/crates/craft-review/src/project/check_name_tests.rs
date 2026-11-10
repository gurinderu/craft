//! A job `name:` holding `${{ … }}` (realm @nick/craft, node #482): GitHub expands it in each
//! run's name, so the map names the literal part before a trailing `(…)` holding it, which the
//! matrix rule counts; any other such name is left to the reviewer, and the literal is never
//! written.

use super::CiEntry;
use super::candidates::{Candidate, candidates_in};

const WF: &str = ".github/workflows/ci.yml";

fn named(name: &str) -> String {
    format!(
        "jobs:\n  build:\n    name: {name}\n    strategy:\n      matrix:\n        arch: [amd64, arm64]\n    steps:\n      - run: cargo test --locked\n"
    )
}

fn top(workflow: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), workflow).unwrap();
    dir
}

fn test_entry(check: &str) -> String {
    format!(
        r#"{{"check":"{check}","signal":"test","command":"cargo test --locked","workflow":"{WF}"}}"#
    )
}

#[test]
fn an_expression_in_a_trailing_parenthesis_is_proposed_as_the_literal_before_it() {
    for name in [
        "Build vodopad (${{ matrix.arch }})",
        "\"Build vodopad (${{ matrix.arch }}, ${{ matrix.os }})\"",
        "Build vodopad (x-${{ matrix.arch }})",
    ] {
        let got = candidates_in(WF, &named(name));
        assert!(
            matches!(&got[..], [Candidate::Resolved(r)] if r.check == "Build vodopad" && r.matrix),
            "{name}: {got:?}"
        );
    }
}

#[test]
fn an_expression_elsewhere_is_left_unresolved_with_a_note() {
    for name in [
        "${{ matrix.os }} build",
        "Build ${{ matrix.arch }}",
        "(${{ matrix.arch }})",
        "Build(${{ matrix.arch }})",
    ] {
        let got = candidates_in(WF, &named(name));
        let [Candidate::Unresolved(u)] = &got[..] else {
            panic!("{name}: {got:?}");
        };
        assert_eq!(u.runs, ["cargo test --locked"], "{name}");
        assert!(
            u.note.as_deref().is_some_and(|n| n.contains("expression")),
            "{name}: {u:?}"
        );
    }
}

#[test]
fn the_proposed_prefix_finds_its_job_at_write() {
    let t = top(&named("Build vodopad (${{ matrix.arch }})"));
    let e = CiEntry::confirmed(&test_entry("Build vodopad"), t.path()).unwrap();
    assert!(e.fresh(t.path()), "{e:?}");
}

#[test]
fn a_check_holding_an_expression_is_refused_at_write_fresh_or_held() {
    let literal = "Build vodopad (${{ matrix.arch }})";
    let t = top(&named(literal));
    let err = CiEntry::confirmed(&test_entry(literal), t.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("unexpanded") && err.contains("craft init --propose"),
        "{err}"
    );
    let mut held = CiEntry::confirmed(&test_entry("Build vodopad"), t.path()).unwrap();
    held.check = literal.to_owned();
    let json = serde_json::to_string(&held).unwrap();
    let err = CiEntry::confirmed(&json, t.path()).unwrap_err().to_string();
    assert!(err.contains("unexpanded"), "{err}");
}
