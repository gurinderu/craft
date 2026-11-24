//! `--paged` from the command line: each step command a driver pages — `start`, `submit`, `status`
//! and `comment` — takes it; a paged step goes to the run directory and its first page is printed
//! framed; `review page --run` prints a page of it, and reads nothing but that run's plain step
//! file; a brief status prints whole. CI runs this file on macOS and Windows too (`store-native`).
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
    let (named, body) = framed(&first);
    assert_eq!(named, run, "the frame names the run directory");
    let file = Path::new(&run).join("host-step.out");
    let step: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(step["run"], Value::String(run.clone()));
    assert!(
        step["tasks"].as_array().is_some_and(|t| !t.is_empty()),
        "{step}"
    );
    // `review page` from 0 prints the very page the start printed.
    assert_eq!(
        craft(
            &["review", "page", "--run", &run, "--from", "0"],
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
        assert_eq!(named, run, "{cmd:?}");
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

/// `review page` over `run`: its exit code and its stderr.
fn page_of(run: &Path, home: &Path) -> (Option<i32>, String) {
    let out = run_craft(
        &[
            "review",
            "page",
            "--run",
            run.to_str().unwrap(),
            "--from",
            "0",
        ],
        home,
    );
    assert!(out.stdout.is_empty(), "{out:?}");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn review_page_reads_only_a_run_directory_s_own_plain_step_file() {
    let tmp = tempfile::tempdir().unwrap();
    let secret = tmp.path().join("notes.txt");
    std::fs::write(&secret, "secret").unwrap();
    // A directory with a step file but no run state is no run directory.
    let bare = tmp.path().join("bare");
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::write(bare.join("host-step.out"), "{}").unwrap();
    let (code, err) = page_of(&bare, tmp.path());
    assert_eq!(code, Some(1));
    assert!(
        err.contains("is not a run directory: it holds no run state"),
        "{err}"
    );
    // A run directory with no step file says so with the io error.
    let run = tmp.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("state.json"), "{}").unwrap();
    let (code, err) = page_of(&run, tmp.path());
    assert_eq!(code, Some(1));
    assert!(
        err.contains("reading ") && err.contains("No such file"),
        "{err}"
    );
    let step = run.join("host-step.out");
    // A symlink in the step file's place: refused by the open on unix, as a reparse point on
    // Windows, where making one may need a privilege the runner lacks.
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&secret, &step)
        .map(|()| true)
        .unwrap();
    #[cfg(windows)]
    let linked = match std::os::windows::fs::symlink_file(&secret, &step) {
        Ok(()) => true,
        Err(e) => {
            println!("skipped the symlink case: no symlink could be made here ({e})");
            false
        }
    };
    #[cfg(any(unix, windows))]
    if linked {
        let (code, err) = page_of(&run, tmp.path());
        assert_eq!(code, Some(1));
        assert!(!err.contains("secret"), "{err}");
        assert!(err.contains("reading "), "{err}");
        std::fs::remove_file(&step).unwrap();
    }
    // A hard link to another file is refused by its link count.
    std::fs::hard_link(&secret, &step).unwrap();
    let (code, err) = page_of(&run, tmp.path());
    assert_eq!(code, Some(1));
    assert!(err.contains("the file has 2 links"), "{err}");
    std::fs::remove_file(&step).unwrap();
    // A FIFO in the step file's place is refused at once, not waited on for a writer.
    #[cfg(unix)]
    {
        let made = Command::new("mkfifo").arg(&step).status().unwrap();
        assert!(made.success());
        let (code, err) = page_within(&run, tmp.path(), std::time::Duration::from_secs(20));
        assert_eq!(code, Some(1));
        assert!(err.contains("not a regular file"), "{err}");
    }
}

/// [`page_of`], the process killed and the test failed when it is still running after `limit`.
#[cfg(unix)]
fn page_within(run: &Path, home: &Path, limit: std::time::Duration) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .env("HOME", home)
        .args([
            "review",
            "page",
            "--run",
            run.to_str().unwrap(),
            "--from",
            "0",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let began = std::time::Instant::now();
    let mut blocked = false;
    while child.try_wait().unwrap().is_none() {
        if began.elapsed() > limit {
            child.kill().unwrap();
            blocked = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        !blocked,
        "review page blocked on the step file for {limit:?}"
    );
    let out = child.wait_with_output().unwrap();
    assert!(out.stdout.is_empty(), "{out:?}");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}
