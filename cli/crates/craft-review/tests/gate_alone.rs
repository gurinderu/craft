//! The mechanical gate alone (`craft review gate`): over the whole change, no run and no lens —
//! red in the review's own words, green, or nothing to gate.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{fixture, git};
use craft_review::gate::GateSetup;
use craft_review::gate::alone::alone;
use serde_json::{Value, json};

/// A directory holding a `cargo` that prints `line` (a clippy JSON line), or nothing.
fn tools(line: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let body = line.map_or(":".to_owned(), |l| format!("printf '%s\\n' '{l}'"));
    common::exe::write_executable(&dir.path().join("cargo"), &format!("#!/bin/sh\n{body}\n"))
        .unwrap();
    dir
}

/// The gate alone over `repo` with the tools in `path`, kept under `out`.
fn gate_in(repo: &Path, path: &Path, out: &Path) -> Value {
    let setup = GateSetup {
        path: Some(path.as_os_str().to_owned()),
        ..GateSetup::default()
    };
    alone(repo, None, &out.join("gate"), &setup).unwrap()
}

/// The gate alone over `repo` with the tools in `path`, kept in a directory dropped after.
fn gate(repo: &Path, path: &Path) -> Value {
    let out = tempfile::tempdir().unwrap();
    gate_in(repo, path, out.path())
}

/// The fixture repository with a Cargo package at its top.
fn package() -> tempfile::TempDir {
    let repo = fixture(true);
    std::fs::write(
        repo.path().join("Cargo.toml"),
        "[package]\nname = \"f\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "chore: the package"]);
    repo
}

#[test]
fn a_red_gate_is_said_as_the_review_says_it() {
    let repo = package();
    let error = json!({"reason": "compiler-message", "message": {"level": "error", "code": {"code": "E0308"},
        "message": "mismatched types", "spans": [{"file_name": "src/lib.rs", "line_start": 1, "is_primary": true}]}});
    let t = tools(Some(&error.to_string()));
    let got = gate(repo.path(), t.path());
    assert_eq!(got["outcome"], json!("fail"), "{got}");
    assert_eq!(
        got["line"],
        json!(
            "⛔ Block — mechanical gate is red (rust). Fix the gate before a semantic review is worthwhile."
        )
    );
    let section = got["section"].as_str().unwrap();
    assert!(section.starts_with("## Gate\n"), "{section}");
    assert!(section.contains("Failed: clippy"), "{section}");
}

#[test]
fn a_quiet_gate_passes_with_no_line() {
    let repo = package();
    let t = tools(None);
    let out = tempfile::tempdir().unwrap();
    let got = gate_in(repo.path(), t.path(), out.path());
    assert_eq!(got["line"], json!(""), "{got}");
    let kept = Path::new(got["dir"].as_str().unwrap()).join(craft_review::gate::alone::RESULT_FILE);
    assert!(
        kept.is_file(),
        "the result is kept for the runs that take it"
    );
    assert_eq!(got["gate"]["tracks"][0]["profile"], json!("rust"));
    assert_ne!(got["outcome"], json!("fail"));
}

#[test]
fn a_change_with_no_gated_profile_has_nothing_to_gate() {
    let repo = fixture(false);
    let t = tools(None);
    let got = gate(repo.path(), t.path());
    assert_eq!(got["outcome"], json!("none"), "{got}");
    assert_eq!(got["section"], json!(""));
}

#[test]
fn a_gate_with_its_tool_missing_is_unknown_and_its_line_says_it_was_not_established() {
    let repo = package();
    let empty = tempfile::tempdir().unwrap();
    let got = gate(repo.path(), empty.path());
    assert_eq!(got["outcome"], json!("unknown"), "{got}");
    assert_eq!(
        got["line"],
        json!("the gate was not established locally (rust: unknown); no CI check informed it")
    );
}
