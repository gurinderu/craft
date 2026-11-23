//! Commits the posting tests lay out by hand: a sibling of the reviewed commit, and whether a
//! repository holds one.
#![expect(clippy::unwrap_used, reason = "the helpers fail the test loudly")]

use std::path::Path;

fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// The tree of `rev` in `repo`.
pub fn tree_of(repo: &Path, rev: &str) -> String {
    git_out(repo, &["rev-parse", &format!("{rev}^{{tree}}")])
}

/// A new commit of `tree` on `parent`, on no branch.
pub fn commit_tree(repo: &Path, tree: &str, parent: &str) -> String {
    git_out(
        repo,
        &["commit-tree", tree, "-p", parent, "-m", "a sibling"],
    )
}

/// Whether `repo` holds `commit`.
pub fn has_commit(repo: &Path, commit: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
        .status()
        .unwrap()
        .success()
}
