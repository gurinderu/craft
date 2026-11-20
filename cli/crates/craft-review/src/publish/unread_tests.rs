//! A branch whose changed lines git cannot print as text — a changed path that is not UTF-8 —
//! leaves the publication no changed-line filter: it says so, with git's reason, and posts each
//! defect on its file, never on a line it could not check.

use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use serde_json::json;

use super::{finished, section, settle};
use crate::state::{RunState, STATE_VERSION};

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A repository whose last commit adds two lines to `src/lib.rs` and a file whose name is not
/// UTF-8, and a finished run of it asked to publish one defect on the new line 3.
fn branch(d: &Path) -> RunState {
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "fn a() {}\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    std::fs::write(d.join("src/lib.rs"), "fn a() {}\nfn b() {}\nfn c() {}\n").unwrap();
    std::fs::write(d.join(std::ffi::OsStr::from_bytes(b"n-\xff.txt")), "x\n").unwrap();
    git(d, &["add", "."]);
    git(
        d,
        &[
            "commit",
            "-qm",
            "feat: b, c and a file whose name is not UTF-8",
        ],
    );
    let head = String::from_utf8(
        std::process::Command::new("git")
            .arg("-C")
            .arg(d)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let finding = json!({"severity": "High", "title": "a defect", "file": "src/lib.rs", "line": 3, "why": "w", "fix": "x", "source": "errors", "tier": "confirmed"});
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": d.display().to_string(), "base": "HEAD~1", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "HEAD~1", "mergeBase": "abc", "head": head.trim(), "dirty": false, "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [], "light": false, "phase": "done", "tasks": [], "verdict": "Block",
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [finding], "notes": [], "notRun": [], "publish": {"asked": true}
    }))
    .unwrap()
}

#[test]
fn a_non_utf8_changed_path_says_the_line_filter_was_not_read_and_posts_on_files() {
    let t = tempfile::tempdir().unwrap();
    let mut run = branch(t.path());
    settle(&mut run);
    let sorting = run.publish.sorting.clone().unwrap();
    assert_eq!(sorting.defects.len(), 1);
    assert_eq!(sorting.defects[0].line, None, "posted on its file");
    assert!(sorting.note.contains("non-UTF-8"), "{}", sorting.note);
    assert!(
        sorting.note.contains("each defect is posted on its file"),
        "{}",
        sorting.note
    );
    let [(_, payload), ..] = finished(&run);
    assert_eq!(payload["inDiffNote"], json!(sorting.note));
    let shown = section(&run);
    let comments = shown.split("## PR comments").nth(1).unwrap();
    assert!(comments.contains(&sorting.note), "{shown}");
}

#[test]
fn a_comment_after_the_run_reads_the_reviewed_head_s_lines_and_says_git_s_reason() {
    let t = tempfile::tempdir().unwrap();
    let run = branch(t.path());
    let why = super::after::lines_at_head(&run).err().unwrap_or_default();
    assert!(why.contains("non-UTF-8"), "{why:?}");
}
