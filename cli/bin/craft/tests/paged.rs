//! `--paged` from the command line: each step command a driver pages — `start`, `submit`, `status`
//! and `comment` — takes it; a paged step goes to the run directory and its first page is printed
//! framed; `review page` prints a page of it, and reads no other file; a brief status prints whole.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

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

fn run_craft(args: &[&str], home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .env("HOME", home)
        .args(args)
        .output()
        .unwrap()
}

fn craft(args: &[&str], home: &Path) -> String {
    let out = run_craft(args, home);
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// A framed page: the file it names, and its body.
fn framed(page: &str) -> (String, String) {
    let lines: Vec<&str> = page.split('\n').collect();
    assert_eq!(lines.len(), 4, "{page}");
    let head: Vec<&str> = lines[0].split(' ').collect();
    assert_eq!(head[0], "craft-out", "{page}");
    let (total, from, count) = (head[2], head[3], head[4]);
    assert_eq!(from, "0");
    assert_eq!(total, count, "a small step is one page: {page}");
    assert_eq!(lines[2], format!("craft-page {count}"));
    (head[1].to_owned(), lines[1].to_owned())
}

/// A repository whose branch adds `src/lib.rs` over `origin/main`, and the run started on it.
fn started(tmp: &Path) -> (String, String) {
    let code = tmp.join("repo");
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "feat: add f"]);
    let run = tmp.join("run").display().to_string();
    let cwd = code.display().to_string();
    let args = [
        "review",
        "start",
        "--run-dir",
        &run,
        "--base",
        "origin/main",
    ];
    let more = ["--no-recall", "--no-gate", "--paged", "--cwd", &cwd];
    let first = craft(&[&args[..], &more[..]].concat(), tmp);
    (run, first)
}

#[test]
fn every_step_command_pages_its_step_into_the_run_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, first) = started(tmp.path());
    let (file, body) = framed(&first);
    assert_eq!(
        file,
        Path::new(&run).join("host-step.out").display().to_string()
    );
    let step: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(step["run"], Value::String(run.clone()));
    assert!(
        step["tasks"].as_array().is_some_and(|t| !t.is_empty()),
        "{step}"
    );
    // `review page` from 0 prints the very page the start printed.
    assert_eq!(
        craft(
            &["review", "page", "--file", &file, "--from", "0"],
            tmp.path()
        ),
        first
    );
    for cmd in [["review", "submit"], ["review", "status"]] {
        let page = craft(
            &[&cmd[..], &["--run", &run, "--paged"]].concat(),
            tmp.path(),
        );
        let (named, body) = framed(&page);
        assert_eq!(named, file, "{cmd:?}");
        let step: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(step["run"], Value::String(run.clone()), "{cmd:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body, "{cmd:?}");
    }
    // A comment takes the flag: an unfinished run is refused for what it is (exit 1), not for
    // an argument it does not know (exit 2).
    let comment = run_craft(&["review", "comment", "--run", &run, "--paged"], tmp.path());
    assert_eq!(comment.status.code(), Some(1), "{comment:?}");
    // A brief status is bounded and prints whole, --paged or not.
    for paged in [&[][..], &["--paged"][..]] {
        let brief = craft(
            &[&["review", "status", "--run", &run, "--brief"][..], paged].concat(),
            tmp.path(),
        );
        assert_eq!(brief.lines().count(), 1, "{brief}");
        assert!(serde_json::from_str::<Value>(&brief).is_ok(), "{brief}");
    }
    // Without --paged, a status prints its step whole on one line.
    let status = craft(&["review", "status", "--run", &run], tmp.path());
    assert_eq!(status.lines().count(), 1, "{status}");
    assert!(serde_json::from_str::<Value>(&status).is_ok(), "{status}");
}

#[test]
fn review_page_reads_only_a_run_directory_s_step_file() {
    let tmp = tempfile::tempdir().unwrap();
    let secret = tmp.path().join("notes.txt");
    std::fs::write(&secret, "secret").unwrap();
    // No run directory: a file of the right name beside no state.
    let named = tmp.path().join("host-step.out");
    std::fs::write(&named, "{}").unwrap();
    // A run directory: a file of another name beside its state, and the step file as a symlink.
    let run = tmp.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("state.json"), "{}").unwrap();
    let misnamed = run.join("step.out");
    std::fs::write(&misnamed, "{}").unwrap();
    let mut refused = vec![secret.clone(), named, misnamed];
    #[cfg(unix)]
    {
        let link = run.join("host-step.out");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        refused.push(link);
    }
    for file in &refused {
        let out = run_craft(
            &[
                "review",
                "page",
                "--file",
                file.to_str().unwrap(),
                "--from",
                "0",
            ],
            tmp.path(),
        );
        assert_eq!(out.status.code(), Some(1), "{file:?}: {out:?}");
        assert!(out.stdout.is_empty(), "{out:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("is not the host-step.out of a run directory"),
            "{err}"
        );
    }
}
