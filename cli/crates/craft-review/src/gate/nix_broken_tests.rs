//! A Nix linter counts as run only when it gave a well-formed answer (realm @nick/craft, node #487):
//! one that panicked, exited with a code it never answers with, printed what does not parse, or
//! could not read a changed file is broken — the track is then unknown, with a flake.nix as
//! without one (realm @nick/craft, node #743), and the note names the linter and what went wrong.
//! The stand-ins answer as statix 0.5.8 and deadnix
//! 1.3.2 were observed to: statix exits 0 with nothing on stdout when clean and 1 with its JSON
//! report on findings; deadnix exits 0 either way (1 only with `--fail`), one JSON line per file
//! with findings, and a result with no `line` where it could not parse or read the file.

use super::nix_bare_tests::bare;
use super::{Gate, Status};
use crate::golden::Golden;

/// statix's real report on findings, as it pretty-prints it, its exit 1.
const STATIX_FINDS: &str = r#"printf '%s\n' '{
  "file": "a.nix",
  "report": [
    {
      "note": "Assignment instead of inherit",
      "code": 3,
      "severity": "Warn",
      "diagnostics": [
        {
          "at": { "from": { "line": 2, "column": 3 }, "to": { "line": 2, "column": 9 } },
          "message": "This assignment is better written with `inherit`",
          "suggestion": null
        }
      ]
    }
  ]
}'; exit 1"#;

/// deadnix's real line on a file with dead bindings, its exit 0.
const DEADNIX_FINDS: &str = r#"printf '%s\n' '{"file":"a.nix","results":[{"column":9,"endColumn":13,"line":1,"message":"Unused lambda pattern: self"}]}'"#;

/// Whether the track is unknown with a note naming `linter` and `what`.
fn broken(gate: &Gate, linter: &str, what: &str) {
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(
        t.notes
            .iter()
            .any(|n| n.contains(linter) && n.contains(what)),
        "{t:?}"
    );
}

#[test]
fn a_linter_exiting_non_zero_with_nothing_printed_is_broken() {
    let panicked = "echo \"thread 'main' panicked at src/main.rs:1:1\" >&2; exit 101";
    let gate = bare(&[("statix", panicked), ("deadnix", "exit 0")]);
    broken(&gate, "statix", "exited 101");
    broken(&gate, "statix", "panicked");
    let gate = bare(&[("statix", "exit 0"), ("deadnix", "exit 2")]);
    broken(&gate, "deadnix", "exited 2");
}

#[test]
fn a_linter_exiting_zero_with_what_is_not_json_is_broken() {
    let gate = bare(&[("statix", "echo oops; exit 0"), ("deadnix", "exit 0")]);
    broken(&gate, "statix", "not JSON");
    let gate = bare(&[("statix", "exit 0"), ("deadnix", "echo oops")]);
    broken(&gate, "deadnix", "not JSON");
    // statix on a file it cannot read exits 0, its stdout empty and its error on stderr.
    let unread = "echo 'config error: path error: file not found: a.nix' >&2";
    let gate = bare(&[("statix", unread), ("deadnix", "exit 0")]);
    broken(&gate, "statix", "config error");
}

#[test]
fn deadnix_that_could_not_parse_a_file_is_broken() {
    let unparsed =
        r#"printf '%s\n' '{"file":"a.nix","results":[{"message":"unexpected end of file"}]}'"#;
    let gate = bare(&[("statix", "exit 0"), ("deadnix", unparsed)]);
    broken(&gate, "deadnix", "a.nix: unexpected end of file");
}

#[test]
fn real_shaped_answers_are_a_run_clean_or_with_findings() {
    let gate = bare(&[("statix", "exit 0"), ("deadnix", "exit 0")]);
    let t = &gate.tracks[0];
    assert_eq!((t.status, t.notes.len()), (Status::Nothing, 0), "{t:?}");
    let gate = bare(&[("statix", STATIX_FINDS), ("deadnix", DEADNIX_FINDS)]);
    let t = &gate.tracks[0];
    assert_eq!((t.status, t.seeds), (Status::Nothing, 2), "{t:?}");
    assert!(t.notes.is_empty(), "{t:?}");
}

/// A flake's check passes, yet a linter that gave no well-formed answer leaves the track unknown
/// and is named with its reason, in a note and in the verdict line (realm @nick/craft, node #743):
/// a seed tool's silence is no pass.
#[test]
fn with_a_flake_a_broken_linter_leaves_the_track_unknown_and_names_it() {
    let gate = super::unanswered_tests::flake_gate(&[
        ("nix", "exit 0"),
        ("statix", "exit 101"),
        ("deadnix", "exit 0"),
    ]);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    broken(&gate, "statix", "exited 101");
    assert_eq!(
        t.unanswered,
        ["statix on a.nix exited 101: no message"],
        "{t:?}"
    );
    assert_eq!(
        super::unknown::reason(&gate),
        Some(
            "the gate was not established locally (nix: unknown); statix on a.nix exited 101: no message; no CI check informed it".to_owned()
        )
    );
}

/// A red flake check fails the track whatever a linter then says: a linter that did not answer
/// is kept with its reason, and its silence folds in behind the red (realm @nick/craft, node #743).
#[test]
fn a_red_flake_check_stays_red_beside_a_linter_that_did_not_answer() {
    let gate = super::unanswered_tests::flake_gate(&[
        ("nix", "echo 'error: attribute x missing' >&2; exit 1"),
        ("statix", "exit 101"),
        ("deadnix", "exit 0"),
    ]);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Fail, "{t:?}");
    assert_eq!(
        t.failed_checks,
        ["nix flake check: error: attribute x missing"],
        "{t:?}"
    );
    assert_eq!(
        t.unanswered,
        ["statix on a.nix exited 101: no message"],
        "{t:?}"
    );
    assert!(gate.exit().is_some(), "{t:?}");
}

/// The provenance of a flakeless Nix gate whose linters both ran clean, held to
/// `content/parity/gate-provenance.json`: `integrations/shared/cli-review-gate.mjs` reads its reason off it.
#[test]
fn the_flakeless_linted_provenance_is_held_for_parity() {
    let gate = bare(&[("statix", "exit 0"), ("deadnix", "exit 0")]);
    let mut g = Golden::open("gate-provenance.json");
    g.check("/nixFlakelessLinted", gate.tracks[0].provenance.as_str());
}
