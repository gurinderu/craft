use std::path::Path;
use std::process::Command;

use super::unchanged_since;

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
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

#[cfg(unix)]
#[test]
fn a_changed_path_that_is_not_utf8_lists_the_change_as_git_quotes_it() {
    use std::os::unix::ffi::OsStrExt;
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README"), "r\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "one"]);
    git(d, &["branch", "base"]);
    std::fs::write(d.join(std::ffi::OsStr::from_bytes(b"\xff.rs")), "a\n").unwrap();
    std::fs::write(d.join("ok.rs"), "a\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "two"]);
    let diff = super::read_diff(d, Some("base"), None).unwrap();
    let quoted = super::git(d, &["diff", "--name-only", "--merge-base", "base"]).unwrap();
    assert_eq!(diff.files, quoted.lines().collect::<Vec<_>>());
}

/// A blobless clone (`--filter=blob:none`) of a bare repository served over `file://`, its
/// `base` branch's blobs absent: the base's `f` differs from `main`'s.
pub(crate) fn blobless(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let src = root.join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    std::fs::write(src.join("f"), "a\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-qm", "one"]);
    git(&src, &["branch", "base"]);
    std::fs::write(src.join("f"), "b\n").unwrap();
    git(&src, &["commit", "-qam", "two"]);
    let remote = root.join("remote.git");
    let at = remote.display().to_string();
    git(root, &["clone", "-q", "--bare", "src", &at]);
    git(&remote, &["config", "uploadpack.allowFilter", "true"]);
    let url = format!("file://{at}");
    git(root, &["clone", "-q", "--filter=blob:none", &url, "clone"]);
    (root.join("clone"), remote)
}

/// The objects the clone `dir` lacks.
pub(crate) fn missing(dir: &Path) -> usize {
    let listed = git(dir, &["rev-list", "--objects", "--missing=print", "--all"]);
    listed.lines().filter(|l| l.starts_with('?')).count()
}

#[test]
fn a_partial_clone_missing_the_bases_blobs_fails_the_read_at_once_and_fetches_nothing() {
    let t = tempfile::tempdir().unwrap();
    let (clone, _remote) = blobless(t.path());
    assert_eq!(missing(&clone), 1, "the base's blob is absent");
    let began = std::time::Instant::now();
    let got = super::read_diff(&clone, Some("origin/base"), None);
    assert!(began.elapsed() < std::time::Duration::from_secs(10));
    let Err(e @ super::GitError::NotFetched { .. }) = &got else {
        panic!("{got:?}");
    };
    let said = e.to_string();
    assert!(said.contains("partial clone"), "{said}");
    assert!(said.contains("diff --stat"), "{said}");
    // The remote was there to answer, and nothing was fetched from it.
    assert_eq!(missing(&clone), 1);
}

#[test]
fn a_partial_clone_whose_remote_is_gone_is_named_as_missing_objects_not_as_the_remote() {
    let t = tempfile::tempdir().unwrap();
    let (clone, remote) = blobless(t.path());
    std::fs::rename(&remote, t.path().join("gone.git")).unwrap();
    let got = super::read_diff(&clone, Some("origin/base"), None);
    let Err(e @ super::GitError::NotFetched { .. }) = &got else {
        panic!("{got:?}");
    };
    assert!(
        !e.to_string()
            .contains("does not appear to be a git repository"),
        "{e}"
    );
}
