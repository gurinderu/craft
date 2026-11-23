//! A repository whose `origin/main` holds some Markdown, and a change committed on top of it.

use std::path::Path;

use super::git;

/// A repository whose `origin/main` holds `before`, with `after` written on top and committed.
pub fn repo(before: &[(&str, &str)], after: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    write(d, &[("LICENSE", "x\n")]);
    write(d, before);
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    write(d, after);
    git(d, &["add", "-A"]);
    git(d, &["commit", "-qm", "docs: the OVN recovery runbook"]);
    dir
}

/// Writes each of `files` under `d` with its text; an empty text removes the file.
fn write(d: &Path, files: &[(&str, &str)]) {
    for (f, text) in files {
        let path = d.join(f);
        if text.is_empty() {
            std::fs::remove_file(path).unwrap();
            continue;
        }
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}
