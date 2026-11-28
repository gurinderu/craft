//! A seed tool the review asked for and that did not answer — semgrep over the changed Rust
//! files, statix or deadnix under a flake — leaves its track unknown and is kept with its reason
//! for the verdict line (realm @nick/craft, node #743): not installed, past the budget, broken,
//! or printing what is not JSON; one that printed JSON with an error of its own likewise (realm
//! @nick/craft, node #744). One the review did not ask for is no signal, and one that answered
//! folds in as it always did. A linter under a flake is `gate/nix_broken_tests.rs`'s; the builders
//! here serve the report's verdict tests too (`report/gate_cap_tests.rs`).

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

/// A seed tool's silence leaves unknown only what it touched: the checks that passed stay known,
/// so the change's tests are known to build and the mutants may run (realm @nick/craft, node
/// #743). A build that did not happen is unknown to them too.
#[test]
fn a_silent_seed_tool_leaves_the_passed_checks_known_to_the_mutants() {
    for gate in [
        rust_gate(None, BUDGET),
        rust_gate(Some(SEMGREP_ERROR), BUDGET),
        rust_gate(Some(SEMGREP_BAD_RULE), BUDGET),
    ] {
        let t = &gate.tracks[0];
        assert_eq!(
            (t.status, t.tests_build()),
            (Status::Unknown, true),
            "{t:?}"
        );
    }
    let (gate, _) = gated(
        &["src/lib.rs"],
        |_, tools| tool(tools, "cargo", "exit 101"),
        BUDGET,
    );
    let t = &gate.tracks[0];
    assert_eq!(
        (t.status, t.tests_build()),
        (Status::Unknown, false),
        "{t:?}"
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

/// semgrep 1.178.0 on an invalid rule beside a valid one: nothing found, two errors of its own,
/// and exit status 7, which the gate does not read (realm @nick/craft, node #744).
const SEMGREP_BAD_RULE: &str = r#"printf '%s\n' '{"results":[],"errors":[{"code":4,"level":"error","type":"InvalidRuleSchemaError","long_msg":"These options were both specified, but they are mutually exclusive: '"'"'pattern'"'"', '"'"'patterns'"'"'","short_msg":"Invalid rule schema"},{"code":7,"level":"error","type":"SemgrepError","message":"invalid configuration file found (1 configs were invalid)"}],"paths":{"scanned":[]}}'
exit 7"#;

/// semgrep 1.178.0 on a file it could not wholly parse: its finding beside a warning, exit 0.
const SEMGREP_PARTIAL: &str = r#"printf '%s\n' '{"results":[{"check_id":".semgrep/unsafe.ys:unchecked-call","path":"src/lib.rs","start":{"line":1,"col":1},"end":{"line":1,"col":9},"extra":{"severity":"WARNING","message":"an unchecked call","line":"pub fn f() {}"}}],"errors":[{"code":3,"level":"warn","type":["PartialParsing",["src/lib.rs"]],"message":"Syntax error at line src/lib.rs:3:\n `{ fn a(` was unexpected","path":"src/lib.rs"}],"paths":{"scanned":["src/lib.rs"]}}'"#;

/// semgrep 1.178.0 answering over the changed file: one finding and no error of its own.
const SEMGREP_CLEAN: &str = r#"printf '%s\n' '{"results":[{"check_id":".semgrep/unsafe.ys:unchecked-call","path":"src/lib.rs","start":{"line":1,"col":1},"end":{"line":1,"col":9},"extra":{"severity":"WARNING","message":"an unchecked call","line":"pub fn f() {}"}}],"errors":[],"paths":{"scanned":["src/lib.rs"]}}'"#;

/// semgrep 1.178.0 asked for a file none of its rules covers: no error, and no file scanned.
const SEMGREP_NONE_SCANNED: &str =
    r#"printf '%s\n' '{"results":[],"errors":[],"paths":{"scanned":[]}}'"#;

#[test]
fn a_semgrep_that_reported_errors_leaves_the_rust_track_unknown() {
    let gate = rust_gate(Some(SEMGREP_BAD_RULE), BUDGET);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert_eq!(t.seeds, 0, "{t:?}");
    let said = "reported 2 error(s): These options were both specified, but they are mutually exclusive: 'pattern', 'patterns'";
    assert_eq!(unanswered(&gate), format!("semgrep {said}"));
    assert_eq!(t.notes, [format!("{SCAN} {said}")]);
    assert!(t.provenance.ends_with(": 0 result(s), 2 error(s)"), "{t:?}");
    assert!(t.missing.is_empty(), "{t:?}");
    assert_eq!(
        unknown::reason(&gate),
        Some(line("rust", &format!("semgrep {said}")))
    );
}

#[test]
fn a_semgrep_that_could_not_wholly_parse_keeps_its_finding_and_leaves_the_track_unknown() {
    let (gate, seeds) = gated(
        &["src/lib.rs"],
        |repo, tools| {
            rules(repo);
            tool(tools, "semgrep", SEMGREP_PARTIAL);
        },
        BUDGET,
    );
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert_eq!(
        (t.seeds, seeds.len()),
        (1, 1),
        "what it could read stays a seed: {t:?}"
    );
    // Its message on one line, whatever line breaks it carried.
    let said = "reported 1 error(s): Syntax error at line src/lib.rs:3: `{ fn a(` was unexpected";
    assert_eq!(unanswered(&gate), format!("semgrep {said}"));
    assert_eq!(t.notes, [format!("{SCAN} {said}")]);
    assert!(t.provenance.ends_with(": 1 result(s), 1 error(s)"), "{t:?}");
    assert_eq!(
        unknown::reason(&gate),
        Some(line("rust", &format!("semgrep {said}")))
    );
}

#[test]
fn an_error_entry_is_said_by_its_message_cut_to_one_line_of_a_note() {
    // One with no message to read; one over a note's length, broken over lines.
    let long = format!(
        r#"[{{"code":3,"message":"first line\n{}"}}]"#,
        "x".repeat(210)
    );
    for (errors, message) in [
        (r#"[{"code":7}]"#.to_owned(), "no message".to_owned()),
        (long, format!("first line {}", "x".repeat(189))),
    ] {
        let script = format!(r#"printf '%s\n' '{{"results":[],"errors":{errors}}}'"#);
        let gate = rust_gate(Some(&script), BUDGET);
        let t = &gate.tracks[0];
        assert_eq!(t.status, Status::Unknown, "{t:?}");
        assert_eq!(
            unanswered(&gate),
            format!("semgrep reported 1 error(s): {message}")
        );
        assert_eq!(t.notes, [format!("{SCAN} reported 1 error(s): {message}")]);
    }
}

#[test]
fn a_semgrep_over_no_file_is_said_so_and_leaves_the_status_as_it_was() {
    let gate = rust_gate(Some(SEMGREP_NONE_SCANNED), BUDGET);
    let t = &gate.tracks[0];
    assert_eq!((t.status, t.seeds), (Status::Pass, 0), "{t:?}");
    assert!(t.unanswered.is_empty(), "{t:?}");
    assert!(unknown::reason(&gate).is_none(), "no cap: {t:?}");
    assert!(
        t.provenance.ends_with(&format!("{SCAN}: no file scanned")),
        "{t:?}"
    );
    assert_eq!(
        t.notes,
        [format!(
            "{SCAN} scanned no file: its rules cover none of the changed ones"
        )]
    );
}

/// semgrep 1.178.0 over the changed file with nothing to report.
const SEMGREP_FOUND_NOTHING: &str =
    r#"printf '%s\n' '{"results":[],"errors":[],"paths":{"scanned":["src/lib.rs"]}}'"#;

#[test]
fn an_answer_that_reports_no_error_is_read_as_it_always_was() {
    // Its findings alone; none over the file it scanned; the older shape, with no `errors` or
    // `paths` to read; and the same clean answer under a non-zero exit, which says no more.
    let older = r#"printf '%s\n' '{"results":[]}'"#;
    let nonzero = format!("{SEMGREP_FOUND_NOTHING}; exit 1");
    for (script, said, seeds) in [
        (SEMGREP_CLEAN, ": 1 result(s)", 1),
        (SEMGREP_FOUND_NOTHING, ": 0 result(s)", 0),
        (older, ": 0 result(s)", 0),
        (&nonzero, ": 0 result(s)", 0),
    ] {
        let (gate, found) = gated(
            &["src/lib.rs"],
            |repo, tools| {
                rules(repo);
                tool(tools, "semgrep", script);
            },
            BUDGET,
        );
        let t = &gate.tracks[0];
        assert_eq!(t.status, Status::Pass, "{t:?}");
        assert!(t.notes.is_empty() && t.unanswered.is_empty(), "{t:?}");
        assert!(unknown::reason(&gate).is_none(), "no cap: {t:?}");
        assert!(t.provenance.ends_with(said), "{t:?}");
        assert_eq!((t.seeds, found.len()), (seeds, seeds), "{t:?}");
    }
}
