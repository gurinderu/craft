//! `--paged` from the command line: `review start` writes its step to the run directory and prints
//! its first page framed; `review page` prints the rest; the pages joined are the step it wrote.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
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

fn craft(args: &[&str], home: &Path) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .env("HOME", home)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// The lines of a framed page between its frame, and the last line it names.
fn body(page: &str) -> (Vec<String>, String, usize) {
    let lines: Vec<&str> = page.lines().collect();
    let head = lines[0].strip_prefix("craft-out ").unwrap();
    let (file, _) = head.rsplit_once(' ').unwrap();
    let last = lines.last().unwrap().strip_prefix("craft-page ").unwrap();
    let inner = lines[1..lines.len() - 1].iter().map(|l| (*l).to_owned());
    (inner.collect(), file.to_owned(), last.parse().unwrap())
}

#[test]
fn a_paged_start_reads_back_page_by_page_as_the_step_it_wrote() {
    let tmp = tempfile::tempdir().unwrap();
    let code = tmp.path().join("repo");
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "feat: add f"]);
    let run = tmp.path().join("run");
    let cwd = code.to_str().unwrap();
    let dir = run.to_str().unwrap();
    let first = craft(
        &[
            "review",
            "start",
            "--run-dir",
            dir,
            "--base",
            "origin/main",
            "--no-recall",
            "--no-gate",
            "--paged",
            "--cwd",
            cwd,
        ],
        tmp.path(),
    );
    let (mut lines, file, mut last) = body(&first);
    assert_eq!(file, run.join("host-step.out").display().to_string());
    let total = std::fs::read_to_string(&file).unwrap().lines().count();
    // `review page` from line 1 prints the very page the start printed.
    assert_eq!(
        craft(
            &["review", "page", "--file", &file, "--from", "1"],
            tmp.path()
        ),
        first
    );
    while last < total {
        let from = (last + 1).to_string();
        let (more, _, to) = body(&craft(
            &["review", "page", "--file", &file, "--from", &from],
            tmp.path(),
        ));
        lines.extend(more);
        last = to;
    }
    let step: Value = serde_json::from_str(&lines.join("\n")).unwrap();
    assert_eq!(step["run"], Value::String(dir.to_owned()));
    assert!(
        step["tasks"].as_array().is_some_and(|t| !t.is_empty()),
        "{step}"
    );
    let whole: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(step, whole);
    // Without --paged, a status prints its step whole on one line.
    let status = craft(&["review", "status", "--run", dir], tmp.path());
    assert_eq!(status.lines().count(), 1, "{status}");
    let status: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(status["run"], Value::String(dir.to_owned()));
}
