//! The tracked files the scout lists: regular files git tracks inside the repository, each once.

use std::path::Path;
use std::process::Command;

use crate::batch::Tracked;
use crate::scout::tracked;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
}

fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q"]);
    for (path, text) in files {
        let at = d.path().join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, text).unwrap();
    }
    git(d.path(), &["add", "-A"]);
    d
}

fn paths(t: &[Tracked]) -> Vec<&str> {
    t.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn only_tracked_regular_files_are_listed_with_their_sizes_and_a_path_narrows_them() {
    let d = repo(&[
        ("src/lib.rs", "fn a() {}\n"),
        ("app.py", "x = 1\n"),
        ("gone.rs", ""),
    ]);
    std::fs::write(d.path().join("untracked.rs"), "fn b() {}").unwrap();
    std::fs::remove_file(d.path().join("gone.rs")).unwrap();
    let all = tracked(d.path(), &[]).unwrap();
    assert_eq!(paths(&all), ["app.py", "src/lib.rs"]);
    assert_eq!(all[1].bytes, 10);
    let under = tracked(d.path(), &["src".into()]).unwrap();
    assert_eq!(paths(&under), ["src/lib.rs"]);
}

#[test]
fn a_path_is_taken_literally_never_as_a_glob() {
    let d = repo(&[("a.rs", ""), ("b.rs", "")]);
    assert!(tracked(d.path(), &["*.rs".into()]).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_tracked_symlink_is_not_read() {
    let d = repo(&[("real.rs", "fn a() {}")]);
    std::os::unix::fs::symlink("real.rs", d.path().join("link.rs")).unwrap();
    git(d.path(), &["add", "-A"]);
    assert_eq!(paths(&tracked(d.path(), &[]).unwrap()), ["real.rs"]);
}

#[cfg(unix)]
#[test]
fn a_tracked_file_a_symlinked_directory_leads_out_of_the_repository_is_not_read() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("x.rs"), "fn secret() {}").unwrap();
    let d = repo(&[("dir/x.rs", "fn a() {}"), ("in/y.rs", "fn b() {}")]);
    std::fs::remove_dir_all(d.path().join("dir")).unwrap();
    std::os::unix::fs::symlink(outside.path(), d.path().join("dir")).unwrap();
    // A directory linked inside the repository still reads.
    std::fs::remove_dir_all(d.path().join("in")).unwrap();
    std::fs::create_dir(d.path().join("real")).unwrap();
    std::fs::write(d.path().join("real/y.rs"), "fn b() {}").unwrap();
    std::os::unix::fs::symlink("real", d.path().join("in")).unwrap();
    assert_eq!(paths(&tracked(d.path(), &[]).unwrap()), ["in/y.rs"]);
}

#[test]
fn a_conflicted_path_is_listed_once() {
    let d = repo(&[("a.rs", "fn a() {}\n")]);
    let id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    let run = |args: &[&str]| git(d.path(), &[&id[..], args].concat());
    run(&["commit", "-qm", "base"]);
    run(&["checkout", "-qb", "side"]);
    std::fs::write(d.path().join("a.rs"), "fn side() {}\n").unwrap();
    run(&["commit", "-qam", "side"]);
    run(&["checkout", "-q", "-"]);
    std::fs::write(d.path().join("a.rs"), "fn main_line() {}\n").unwrap();
    run(&["commit", "-qam", "main"]);
    let merged = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(id)
        .args(["merge", "-q", "side"])
        .output()
        .unwrap();
    assert!(!merged.status.success(), "the merge conflicts");
    assert_eq!(paths(&tracked(d.path(), &[]).unwrap()), ["a.rs"]);
}

#[test]
fn a_directory_git_does_not_track_is_refused_as_not_git() {
    let d = tempfile::tempdir().unwrap();
    let got = tracked(d.path(), &[]);
    assert!(
        matches!(&got, Err(crate::AuditError::NotGit { .. })),
        "{got:?}"
    );
}
