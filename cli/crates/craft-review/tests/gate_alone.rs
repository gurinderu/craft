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
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let body = line.map_or(":".to_owned(), |l| format!("printf '%s\\n' '{l}'"));
    let path = dir.path().join("cargo");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

/// The gate alone over `repo` with the tools in `path`.
fn gate(repo: &Path, path: &Path) -> Value {
    let out = tempfile::tempdir().unwrap();
    let setup = GateSetup {
        path: Some(path.as_os_str().to_owned()),
        ..GateSetup::default()
    };
    alone(repo, None, &out.path().join("gate"), &setup).unwrap()
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
    let got = gate(repo.path(), t.path());
    assert_eq!(got["line"], json!(""), "{got}");
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
