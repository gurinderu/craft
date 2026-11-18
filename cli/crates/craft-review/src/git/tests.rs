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

#[test]
fn a_changed_file_is_listed_by_its_own_name_whatever_its_characters() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README"), "r\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "one"]);
    git(d, &["branch", "base"]);
    let names = ["café.rs", "my dir/x.rs", "q\"t.rs", "tab\tx.rs"];
    std::fs::create_dir_all(d.join("my dir")).unwrap();
    for n in names {
        std::fs::write(d.join(n), "a\n").unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "two"]);
    let diff = super::read_diff(d, Some("base"), None).unwrap();
    let mut files = diff.files;
    files.sort();
    let mut want: Vec<String> = names.iter().map(|n| (*n).to_owned()).collect();
    want.sort();
    assert_eq!(files, want);
}

/// Writes a file named by the raw bytes `name` under `d`.
#[cfg(unix)]
fn write_raw(d: &Path, name: &[u8]) {
    use std::os::unix::ffi::OsStrExt;
    std::fs::write(d.join(std::ffi::OsStr::from_bytes(name)), "a\n").unwrap();
}

#[cfg(unix)]
#[test]
fn a_changed_path_that_is_not_utf8_is_listed_as_git_quotes_it_and_the_change_still_reads() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README"), "r\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "one"]);
    git(d, &["branch", "base"]);
    for n in [&b"caf\xe9.rs"[..], b"q\"\\\x01\xff.rs", b"ok.rs"] {
        write_raw(d, n);
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "two"]);
    let diff = super::read_diff(d, Some("base"), None).unwrap();
    let quoted = git(
        d,
        &["-c", "core.quotePath=true", "diff", "--name-only", "base"],
    );
    let quoted: Vec<&str> = quoted.lines().filter(|l| *l != "ok.rs").collect();
    assert_eq!(quoted.len(), 2, "{quoted:?}");
    let mut files = diff.files.clone();
    files.sort();
    let mut want: Vec<String> = quoted.iter().map(|q| (*q).to_owned()).collect();
    want.push("ok.rs".into());
    want.sort();
    assert_eq!(files, want);
    let mut not_utf8 = diff.not_utf8;
    not_utf8.sort();
    let mut want: Vec<String> = quoted.iter().map(|q| (*q).to_owned()).collect();
    want.sort();
    assert_eq!(not_utf8, want);
}
