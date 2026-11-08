use std::path::Path;
use std::process::Command;

use super::unchanged_since;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[test]
fn a_change_is_seen_from_a_subdirectory_of_the_repository() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "a\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "one"]);
    let commit = git(d, &["rev-parse", "HEAD"]);
    let sub = d.join("src");
    assert!(unchanged_since(&sub, &commit, "src/lib.rs"));
    std::fs::write(d.join("src/lib.rs"), "b\n").unwrap();
    // Read from `src/`, the path would have been `src/src/lib.rs`, which never changes.
    assert!(!unchanged_since(&sub, &commit, "src/lib.rs"));
    assert!(!unchanged_since(d, &commit, "src/lib.rs"));
}
