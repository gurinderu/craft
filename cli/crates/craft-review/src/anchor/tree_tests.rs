//! The head tree as `git` holds it: a file, a missing path, a symlink and a directory, read from a
//! subdirectory.

use std::path::Path;
use std::process::Command;

use super::{Blob, GitTree, Tree};

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
fn the_head_tree_is_read_through_git_never_through_a_link_or_the_working_tree() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "a\nb\n").unwrap();
    std::os::unix::fs::symlink("/etc/hostname", d.join("out")).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "one"]);
    let head = git(d, &["rev-parse", "HEAD"]);
    std::fs::write(d.join("src/lib.rs"), "changed in the working tree\n").unwrap();
    // Read from a subdirectory, the paths are still the top's.
    let sub = d.join("src");
    let tree = GitTree::new(sub.to_str().unwrap(), &head);
    assert_eq!(
        tree.at_head("src/lib.rs"),
        Blob::Text("a\nb\n".into()),
        "the head's blob, not the working tree's file"
    );
    assert_eq!(tree.at_head("src/gone.rs"), Blob::Missing);
    assert_eq!(
        tree.at_head("out"),
        Blob::Unreadable,
        "a symlink is not followed"
    );
    assert_eq!(tree.at_head("src"), Blob::Unreadable, "a directory");
}
