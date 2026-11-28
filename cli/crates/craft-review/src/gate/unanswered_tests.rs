//! A seed tool the review asked for and that did not answer — semgrep over the changed Rust
//! files, statix or deadnix under a flake — leaves its track unknown and is kept with its reason
//! for the verdict line (realm @nick/craft, node #743): not installed, past the budget, broken,
//! or printing what is not JSON. One the review did not ask for is no signal, and one that
//! answered folds in as it always did. A linter under a flake is `gate/nix_broken_tests.rs`'s;
//! the builders here serve the report's verdict tests too (`report/gate_cap_tests.rs`).

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::tests::{nix_track, package, repo, setup, tool};
use super::{Gate, Status, Track as GateTrack, run, unknown};
use crate::state::Track;

/// Long enough that no tool is cut.
pub(crate) const BUDGET: Duration = Duration::from_secs(30);

/// semgrep dying on an internal error: nothing on stdout, its error on stderr.
pub(crate) const SEMGREP_ERROR: &str =
    r#"echo "Semgrep encountered an internal error" >&2; exit 2"#;

/// How provenance and the notes name the semgrep these tests ask for — the scan up to its
/// `--config`, not the files after `--`.
const SCAN: &str = "`semgrep scan --json --metrics=off --quiet --config .semgrep`";

/// semgrep's JSON on one finding of a repository rule, on the change's first line.
const SEMGREP_FINDS: &str = r#"printf '%s\n' '{"results":[{"check_id":".semgrep/unsafe.ys:unchecked-call","path":"src/lib.rs","start":{"line":1,"col":1},"end":{"line":1,"col":9},"extra":{"severity":"WARNING","message":"an unchecked call","line":"pub fn f() {}"}}]}'"#;

/// A repository rule directory for semgrep at the top of `repo`.
fn rules(repo: &Path) {
    std::fs::create_dir(repo.join(".semgrep")).unwrap();
}

/// The Rust gate over the test package with `files` changed, a `cargo` that exits 0 and what
/// `arrange` makes of the repository and the tools' directory: the gate and its seeds.
fn gated(
    files: &[&str],
    arrange: impl FnOnce(&Path, &Path),
    budget: Duration,
) -> (Gate, Vec<Value>) {
    let (repo, tools, run_dir) = (
        package(None),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    tool(tools.path(), "cargo", "exit 0");
    arrange(repo.path(), tools.path());
    let files: Vec<String> = files.iter().map(|f| (*f).to_owned()).collect();
    run(
        repo.path(),
        "HEAD~1",
        &[Track::new("rust", files)],
        &setup(tools.path(), budget),
        run_dir.path(),
    )
}

/// The same over `src/lib.rs`, semgrep asked: a `semgrep` running `script`, none installed when
/// `None`.
pub(crate) fn rust_gate(semgrep: Option<&str>, budget: Duration) -> Gate {
    gated(
        &["src/lib.rs"],
        |repo, tools| {
            rules(repo);
            if let Some(script) = semgrep {
                tool(tools, "semgrep", script);
            }
        },
        budget,
    )
    .0
}

/// The Nix gate over the test repository, a flake, with `tools` on PATH.
pub(crate) fn flake_gate(tools: &[(&str, &str)]) -> Gate {
    let (repo, dir, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    for (name, script) in tools {
        tool(dir.path(), name, script);
    }
    run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(dir.path(), BUDGET),
        run_dir.path(),
    )
    .0
}

/// Why the gate's one track is unknown: its one seed tool that did not answer, with its reason.
fn unanswered(gate: &Gate) -> &str {
    assert_eq!(gate.tracks.len(), 1, "{:?}", gate.tracks);
    let t = &gate.tracks[0];
    assert_eq!(t.unanswered.len(), 1, "{t:?}");
    &t.unanswered[0]
}

/// The verdict line of a gate whose `profile` is unknown for one silent seed tool that `said`,
/// no CI having been read.
fn line(profile: &str, said: &str) -> String {
    format!(
        "the gate was not established locally ({profile}: unknown); {said}; no CI check informed it"
    )
}

#[test]
fn a_semgrep_that_printed_no_json_leaves_the_rust_track_unknown() {
    let gate = rust_gate(Some(SEMGREP_ERROR), BUDGET);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let why = "semgrep printed no JSON: Semgrep encountered an internal error";
    assert_eq!(unanswered(&gate), why);
    assert_eq!(
        t.notes,
        [format!(
            "{SCAN} printed no JSON: Semgrep encountered an internal error"
        )]
    );
    assert!(t.provenance.ends_with(": unreadable output"), "{t:?}");
    assert!(t.missing.is_empty(), "{t:?}");
    assert_eq!(unknown::reason(&gate), Some(line("rust", why)));
}

#[test]
fn a_semgrep_not_installed_leaves_the_rust_track_unknown() {
    let gate = rust_gate(None, BUDGET);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert_eq!(t.missing, ["semgrep"]);
    assert_eq!(unanswered(&gate), "semgrep is not installed");
    assert_eq!(
        t.notes,
        ["semgrep is not installed — its signal is unknown, not a pass"]
    );
    assert_eq!(
        unknown::reason(&gate),
        Some(line("rust", "semgrep is not installed"))
    );
}

/// A track whose silent seed tools said `unanswered`.
fn silent(profile: &str, status: Status, unanswered: &[&str]) -> GateTrack {
    GateTrack {
        profile: profile.into(),
        status,
        unanswered: unanswered.iter().map(|u| (*u).to_owned()).collect(),
        ..GateTrack::default()
    }
}

#[test]
fn the_line_names_the_silent_tools_of_the_unknown_tracks_alone() {
    // A track that failed carries its own: the red gate's line names it.
    let gate = Gate {
        tracks: vec![
            silent("rust", Status::Fail, &["semgrep is not installed"]),
            silent(
                "nix",
                Status::Unknown,
                &["statix on a.nix exited 101: no message"],
            ),
        ],
        ..Gate::default()
    };
    assert_eq!(
        unknown::reason(&gate),
        Some(line("nix", "statix on a.nix exited 101: no message"))
    );
}

#[test]
fn the_silent_tools_are_named_before_what_ci_said_of_the_gate() {
    let ci = "CI for def1234: clippy green (checks clippy) — informs only, not a pass";
    let mut t = silent("rust", Status::Unknown, &["semgrep is not installed"]);
    t.provenance = ci.into();
    let gate = Gate {
        tracks: vec![t],
        ..Gate::default()
    };
    assert_eq!(
        unknown::reason(&gate),
        Some(format!(
            "the gate was not established locally (rust: unknown); semgrep is not installed; {ci}"
        ))
    );
}

#[test]
fn a_semgrep_not_asked_for_is_no_signal() {
    // No repository rules; then rules, but a change that touched no Rust file.
    let (no_rules, _) = gated(
        &["src/lib.rs"],
        |_, tools| tool(tools, "semgrep", "exit 3"),
        BUDGET,
    );
    let (no_rust, _) = gated(
        &["Cargo.toml"],
        |repo, tools| {
            rules(repo);
            tool(tools, "semgrep", "exit 3");
        },
        BUDGET,
    );
    for gate in [no_rules, no_rust] {
        let t = &gate.tracks[0];
        assert_eq!(t.status, Status::Pass, "{t:?}");
        assert!(t.unanswered.is_empty(), "{t:?}");
        assert!(unknown::reason(&gate).is_none(), "no cap: {t:?}");
        assert_eq!(
            t.notes,
            [
                "semgrep: no repository rules (semgrep/ or .semgrep/) or no changed Rust file — skipped"
            ]
        );
    }
}

#[test]
fn a_semgrep_that_answered_seeds_and_leaves_the_status_as_it_was() {
    let (gate, seeds) = gated(
        &["src/lib.rs"],
        |repo, tools| {
            rules(repo);
            tool(tools, "semgrep", SEMGREP_FINDS);
        },
        BUDGET,
    );
    let t = &gate.tracks[0];
    assert_eq!((t.status, t.seeds), (Status::Pass, 1), "{t:?}");
    assert!(t.notes.is_empty() && t.unanswered.is_empty(), "{t:?}");
    assert!(unknown::reason(&gate).is_none(), "no cap: {t:?}");
    assert!(t.provenance.ends_with(": 1 result(s)"), "{t:?}");
    let [s] = seeds.as_slice() else {
        panic!("{seeds:?}")
    };
    let got = (
        s["source"].as_str(),
        s["toolRule"].as_str(),
        s["severity"].as_str(),
        s["file"].as_str(),
        s["line"].as_u64(),
    );
    assert_eq!(
        got,
        (
            Some("semgrep"),
            Some(".semgrep/unsafe.ys:unchecked-call"),
            Some("Medium"),
            Some("src/lib.rs"),
            Some(1),
        )
    );
}

#[test]
fn a_semgrep_past_the_budget_leaves_the_rust_track_unknown() {
    let gate = rust_gate(Some("while :; do :; done"), Duration::from_millis(500));
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let why = unanswered(&gate);
    assert!(
        why.starts_with("semgrep hit the gate's time budget after "),
        "{t:?}"
    );
    assert!(t.provenance.ends_with(": timed out"), "{t:?}");
}

#[cfg(unix)]
#[test]
fn a_semgrep_that_could_not_start_leaves_the_rust_track_unknown() {
    let gate = gated(
        &["src/lib.rs"],
        |repo, tools| {
            rules(repo);
            std::fs::write(tools.join("semgrep"), "not a program").unwrap();
        },
        BUDGET,
    )
    .0;
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let why = unanswered(&gate);
    assert!(
        why.starts_with("semgrep could not run: ") && why.contains("could not start"),
        "{t:?}"
    );
    assert!(t.missing.is_empty(), "installed, only broken: {t:?}");
    // One note for one silence: the one the run's outcome already wrote.
    assert_eq!(t.notes.len(), 1, "{t:?}");
}
