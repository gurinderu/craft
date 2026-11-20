//! A change whose lines git cannot print as text — a changed path that is not UTF-8 — leaves the
//! gate no changed line to match a diagnostic to: said in its section and as a degraded note,
//! never a gate that reads clean.

use std::os::unix::ffi::OsStrExt;
use std::time::Duration;

use super::tests::{git, nix_track, repo, setup, tool};
use super::{run, section};

#[test]
fn a_non_utf8_changed_path_is_named_as_the_gate_s_unread_lines_not_a_clean_gate() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let name = std::ffi::OsStr::from_bytes(b"notes-\xff.txt");
    std::fs::write(repo.path().join(name), "x\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(
        repo.path(),
        &["commit", "-qm", "feat: a file whose name is not UTF-8"],
    );
    tool(tools.path(), "nix", "exit 0");
    tool(
        tools.path(),
        "statix",
        r#"printf '%s' '{"file":"a.nix","report":[{"note":"n","code":3,"severity":"Warn","diagnostics":[{"at":{"from":{"line":2,"column":3}},"message":"m"}]}]}'; exit 1"#,
    );
    tool(tools.path(), "deadnix", "exit 0");
    let (gate, seeds) = run(
        repo.path(),
        "HEAD~2",
        &nix_track(),
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    assert!(seeds.is_empty(), "{seeds:?}");
    assert!(
        gate.unread_lines.contains("non-UTF-8"),
        "{:?}",
        gate.unread_lines
    );
    let shown = section(&gate);
    assert!(
        shown.contains("could not read the change's lines"),
        "{shown}"
    );
    assert!(shown.contains("non-UTF-8"), "{shown}");
}
