//! The PR worktree laid in a partial clone: the blobs of the PR's head it lacks are fetched as
//! craft's own remote git runs (realm @nick/craft, node #545), not refused and not unguarded.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::add;
use crate::cancel::Cancel;

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

/// A blobless clone of a bare repository served over `file://`, and the commit of its `pr`
/// branch, whose new file's blob the clone lacks.
fn blobless(root: &Path) -> (PathBuf, String) {
    let src = root.join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    std::fs::write(src.join("f"), "a\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-qm", "one"]);
    git(&src, &["checkout", "-qb", "pr"]);
    std::fs::write(src.join("g"), "pr\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-qm", "two"]);
    let pr = git(&src, &["rev-parse", "HEAD"]);
    git(&src, &["checkout", "-q", "main"]);
    let remote = root.join("remote.git").display().to_string();
    git(root, &["clone", "-q", "--bare", "src", &remote]);
    git(
        Path::new(&remote),
        &["config", "uploadpack.allowFilter", "true"],
    );
    let url = format!("file://{remote}");
    git(root, &["clone", "-q", "--filter=blob:none", &url, "clone"]);
    (root.join("clone"), pr)
}

#[test]
fn the_pr_worktree_of_a_partial_clone_fetches_the_blobs_its_head_lacks() {
    let t = tempfile::tempdir().unwrap();
    let (clone, pr) = blobless(t.path());
    let dir = t.path().join("wt");
    let got = add(&clone, &dir, &pr, &Cancel::default());
    assert_eq!(got, Ok(()));
    assert_eq!(std::fs::read_to_string(dir.join("g")).unwrap(), "pr\n");
}

#[test]
fn the_lazy_fetch_of_the_pr_worktree_runs_detached_and_never_prompts() {
    let t = tempfile::tempdir().unwrap();
    let (clone, pr) = blobless(t.path());
    // The promisor remote over ssh, the ssh a fake that says what it saw and fails.
    let ssh = t.path().join("ssh");
    let seen = t.path().join("seen");
    let script = format!(
        "#!/bin/sh\n{{ echo \"prompt=$GIT_TERMINAL_PROMPT\"; echo \"sid=$(ps -o sid= -p $$ | tr -d ' ')\"; }} > '{}'\nexit 255\n",
        seen.display()
    );
    std::fs::write(&ssh, script).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &clone,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://git@example.invalid/org/r.git",
        ],
    );
    git(
        &clone,
        &["config", "core.sshCommand", &ssh.display().to_string()],
    );
    let got = add(&clone, &t.path().join("wt"), &pr, &Cancel::default());
    assert!(got.is_err(), "{got:?}");
    let seen = std::fs::read_to_string(&seen).expect("the lazy fetch reached the remote's ssh");
    assert!(seen.contains("prompt=0\n"), "{seen}");
    let ours = nix::unistd::getsid(None).unwrap().to_string();
    assert!(!seen.contains(&format!("sid={ours}\n")), "{seen}");
}

/// The PR's base side absent: the clone is checked out on `other`, whose `f` is not `main`'s, and
/// the PR changes `main`'s `f`.
#[test]
fn a_pr_worktree_laid_in_a_partial_clone_reads_its_diff_from_the_base() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let src = root.join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    std::fs::write(src.join("f"), "main\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-qm", "one"]);
    git(&src, &["checkout", "-qb", "pr"]);
    std::fs::write(src.join("f"), "pr\n").unwrap();
    git(&src, &["commit", "-qam", "pr"]);
    let pr = git(&src, &["rev-parse", "HEAD"]);
    git(&src, &["checkout", "-q", "main"]);
    git(&src, &["checkout", "-qb", "other"]);
    std::fs::write(src.join("f"), "other\n").unwrap();
    git(&src, &["commit", "-qam", "other"]);
    let remote = root.join("remote.git").display().to_string();
    git(root, &["clone", "-q", "--bare", "src", &remote]);
    git(
        Path::new(&remote),
        &["config", "uploadpack.allowFilter", "true"],
    );
    let url = format!("file://{remote}");
    git(
        root,
        &[
            "clone",
            "-q",
            "-b",
            "other",
            "--filter=blob:none",
            &url,
            "clone",
        ],
    );
    let clone = root.join("clone");
    let dir = root.join("wt");
    assert_eq!(add(&clone, &dir, &pr, &Cancel::default()), Ok(()));
    let diff = crate::git::warm::read_diff(&dir, Some("origin/main"), None, &Cancel::default());
    let diff = diff.unwrap();
    assert_eq!(diff.files, ["f"]);
    assert!(diff.stat.contains("1 file changed"), "{}", diff.stat);
}

#[test]
fn a_worktree_add_failing_on_this_side_says_nothing_of_access() {
    let t = tempfile::tempdir().unwrap();
    let (clone, pr) = blobless(t.path());
    let dir = t.path().join("wt");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("x"), "taken\n").unwrap();
    let got = add(&clone, &dir, &pr, &Cancel::default());
    let Err(why) = got else { panic!("{got:?}") };
    assert!(why.contains("already exists"), "{why}");
    assert!(!why.contains("ssh-agent"), "{why}");
}
