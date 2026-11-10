//! The Rust gate of a run scoped to one crate of a workspace (`path`): clippy lints that crate's
//! package alone, by name, and semgrep reads only the scope's files; unscoped, clippy lints each
//! changed package by its manifest, as before.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{git, opts};
use craft_review::gate::GateSetup;
use craft_review::step::{self, StartOptions};

fn write(dir: &Path, file: &str, text: &str) {
    let path = dir.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// The root manifest of a workspace of `crates/a` and `crates/b` that is no package itself.
const VIRTUAL: &str = "[workspace]\nmembers = [\"crates/a\", \"crates/b\"]\n";

/// A workspace of two crates, `alpha` in `crates/a` and `beta` in `crates/b`, its root manifest
/// `root`, whose branch changes both.
fn workspace(root: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    write(d, "Cargo.toml", root);
    for (sub, name) in [("a", "alpha"), ("b", "beta")] {
        let manifest = format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\n");
        write(d, &format!("crates/{sub}/Cargo.toml"), &manifest);
        write(d, &format!("crates/{sub}/src/lib.rs"), "\n");
    }
    write(d, ".semgrep/rules.yml", "rules: []\n");
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    for sub in ["a", "b"] {
        write(d, &format!("crates/{sub}/src/lib.rs"), "pub fn f() {}\n");
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f in both crates"]);
    dir
}

/// A `cargo` and a `semgrep` that each append their arguments to `<dir>/<tool>.log`.
fn logging_tools(dir: &Path) {
    for (tool, out) in [("cargo", ""), ("semgrep", "printf '%s' '{\"results\":[]}'")] {
        let log = dir.join(format!("{tool}.log"));
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n{out}\n",
            log.display()
        );
        common::exe::write_executable(&dir.join(tool), &script).unwrap();
    }
}

/// The arguments each tool was run with over a workspace whose root manifest is `root`, scoped to
/// `path` or not.
fn calls_under(root: &str, path: Option<&str>) -> (String, String) {
    let repo = workspace(root);
    let out = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    logging_tools(tools.path());
    step::start(&StartOptions {
        path: path.map(str::to_owned),
        gate: Some(GateSetup {
            path: Some(tools.path().as_os_str().to_owned()),
            ..GateSetup::default()
        }),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let read = |t: &str| std::fs::read_to_string(tools.path().join(format!("{t}.log"))).unwrap();
    (read("cargo"), read("semgrep"))
}

/// [`calls_under`] a virtual workspace.
fn gate_calls(path: Option<&str>) -> (String, String) {
    calls_under(VIRTUAL, path)
}

#[test]
fn a_run_scoped_to_a_crate_lints_its_package_alone() {
    let (cargo, semgrep) = gate_calls(Some("crates/a"));
    assert!(!cargo.is_empty(), "clippy ran");
    for call in cargo.lines() {
        assert!(
            call.contains("--manifest-path crates/a/Cargo.toml -p alpha"),
            "{call}"
        );
        assert!(
            !call.contains("beta") && !call.contains("crates/b"),
            "{call}"
        );
    }
    assert!(semgrep.contains("crates/a/src/lib.rs"), "{semgrep}");
    assert!(!semgrep.contains("crates/b"), "{semgrep}");
    // A file inside the crate scopes to the crate's package too.
    let (cargo, _) = gate_calls(Some("crates/a/src/lib.rs"));
    assert!(
        cargo.contains("-p alpha") && !cargo.contains("beta"),
        "{cargo}"
    );
}

#[test]
fn an_unscoped_run_lints_each_changed_package_by_its_manifest() {
    let (cargo, semgrep) = gate_calls(None);
    assert!(cargo.contains("--manifest-path crates/a/Cargo.toml --all-targets"));
    assert!(cargo.contains("--manifest-path crates/b/Cargo.toml --all-targets"));
    assert!(!cargo.contains(" -p "), "{cargo}");
    assert!(semgrep.contains("crates/a/src/lib.rs") && semgrep.contains("crates/b/src/lib.rs"));
    // The file operands follow `--`, so none is read as an option.
    assert!(
        semgrep.contains(" -- crates/a/src/lib.rs") || semgrep.contains(" -- crates/b/src/lib.rs"),
        "{semgrep}"
    );
}

#[test]
fn a_scope_under_a_root_that_is_package_and_workspace_lints_each_member_by_its_manifest() {
    let root = format!("[package]\nname = \"root\"\nversion = \"0.1.0\"\n\n{VIRTUAL}");
    let (cargo, _) = calls_under(&root, Some("crates"));
    assert!(!cargo.contains(" -p "), "{cargo}");
    assert!(
        cargo.contains("--manifest-path crates/a/Cargo.toml"),
        "{cargo}"
    );
    assert!(
        cargo.contains("--manifest-path crates/b/Cargo.toml"),
        "{cargo}"
    );
}
