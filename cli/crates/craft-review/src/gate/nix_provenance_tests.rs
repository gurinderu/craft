//! The Gate section's provenance gives each Nix linter one state: statix that ran on the first
//! changed file and broke on a later one is broken, not also local.

use std::process::Command;
use std::time::Duration;

use super::tests::{repo, setup, tool};
use crate::state::Track;

/// The test repository with `b.nix` added in a third commit and its `flake.nix` removed.
fn two_files() -> tempfile::TempDir {
    let dir = repo();
    let d = dir.path();
    std::fs::write(d.join("b.nix"), "{ }\n").unwrap();
    for args in [&["add", "."][..], &["commit", "-qm", "feat: b"]] {
        let ok = Command::new("git")
            .arg("-C")
            .arg(d)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .unwrap();
        assert!(ok.success(), "git {args:?}");
    }
    std::fs::remove_file(d.join("flake.nix")).unwrap();
    dir
}

#[test]
fn statix_broken_on_a_later_file_is_only_broken_in_the_provenance() {
    let (repo, dir, run_dir) = (
        two_files(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    // Clean on `a.nix`, not JSON on `b.nix`: the file is statix's last argument.
    let statix = r#"for f; do :; done; [ "$f" = b.nix ] && echo oops; exit 0"#;
    tool(dir.path(), "statix", statix);
    tool(dir.path(), "deadnix", "exit 0");
    let track = vec![Track::new("nix", vec!["a.nix".into(), "b.nix".into()])];
    let (gate, _) = super::run(
        repo.path(),
        "HEAD~2",
        &track,
        &setup(dir.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let p = &gate.tracks[0].provenance;
    assert_eq!(p.matches("`statix check -o json`:").count(), 1, "{p}");
    assert!(p.contains("`statix check -o json`: broken"), "{p}");
}
