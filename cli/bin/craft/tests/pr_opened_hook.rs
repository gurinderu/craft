//! `craft hook pr-opened` as the harness runs it: the `PostToolUse` input of a Bash call on stdin,
//! a real repository with an `origin`, a stub `gh` on `PATH` answering `gh pr view`, a run store as
//! the record writer lays it out; the output read back as the harness reads it.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

const URL: &str = "https://github.com/o/r/pull/7";

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

fn commit(d: &Path, file: &str) {
    std::fs::write(d.join(file), format!("{file}\n")).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", file]);
}

/// A checkout `r` of a bare `origin` whose `main` is one commit, on `feat/x` one commit past it.
struct Repo {
    _dir: tempfile::TempDir,
    r: PathBuf,
    store: PathBuf,
    bin: PathBuf,
    head: String,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let (origin, r) = (dir.path().join("origin.git"), dir.path().join("r"));
    std::fs::create_dir_all(&r).unwrap();
    git(
        dir.path(),
        &["init", "-q", "--bare", "-b", "main", "origin.git"],
    );
    git(&r, &["init", "-q", "-b", "main"]);
    git(&r, &["remote", "add", "origin", origin.to_str().unwrap()]);
    commit(&r, "a");
    git(&r, &["push", "-q", "origin", "main"]);
    git(&r, &["checkout", "-qb", "feat/x"]);
    commit(&r, "b");
    let head = git(&r, &["rev-parse", "HEAD"]);
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    Repo {
        store: dir.path().join("runs"),
        r,
        bin,
        head,
        _dir: dir,
    }
}

impl Repo {
    /// `gh` on PATH as a script with `body`.
    fn gh(&self, body: &str) {
        let gh = self.bin.join("gh");
        std::fs::write(&gh, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// `gh pr view` answering with `head` as the PR's head on `main`, and its arguments kept.
    fn gh_answers(&self, head: &str) {
        let args = self.bin.join("args");
        self.gh(&format!(
            "printf '%s\\n' \"$@\" > '{}'\nprintf '{{\"headRefOid\":\"{head}\",\"baseRefName\":\"main\",\"headRefName\":\"feat/x\"}}\\n'",
            args.display()
        ));
    }

    /// Files a finished full review of the whole change on `head` unless `narrow` overrides a field.
    fn file_run(&self, ts: &str, head: &str, narrow: &[(&str, Value)]) {
        std::fs::create_dir_all(&self.store).unwrap();
        let line = json!({"ts": ts, "kind": "workflow", "name": "review", "nested": false,
            "project": self.r.canonicalize().unwrap(), "branch": "feat/x", "head": head,
            "verdict": "Approve", "dirty": false});
        let mut detail = line.clone();
        for (k, v) in [
            ("lensScope", json!("full")),
            ("depth", json!("full")),
            ("path", json!("")),
            ("base", json!("origin/main")),
            ("notRun", json!([])),
            ("lensRounds", json!([{}])),
        ] {
            detail[k] = v;
        }
        for (k, v) in narrow {
            detail[*k] = v.clone();
        }
        let mut index = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.store.join("index.jsonl"))
            .unwrap();
        writeln!(index, "{line}").unwrap();
        std::fs::write(
            self.store.join(format!("{ts}-workflow-review.json")),
            detail.to_string(),
        )
        .unwrap();
    }

    /// The hook run after `command` printed `stdout`; its output parsed, `null` when empty.
    fn hook(&self, command: &str, stdout: &str) -> Value {
        let input = json!({"session_id": "s", "transcript_path": "/t", "cwd": self.r,
            "hook_event_name": "PostToolUse", "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"stdout": stdout, "stderr": "", "interrupted": false},
            "tool_use_id": "u", "duration_ms": 900});
        self.raw(&input.to_string())
    }

    fn raw(&self, stdin: &str) -> Value {
        let path = format!(
            "{}:{}",
            self.bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
            .args(["hook", "pr-opened", "--store"])
            .arg(&self.store)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "the hook exits 0");
        let text = String::from_utf8(out.stdout).unwrap();
        if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap()
        }
    }
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap()
}

fn human(v: &Value) -> String {
    v["systemMessage"].as_str().unwrap().to_owned()
}

fn model(v: &Value) -> String {
    assert_eq!(
        v["hookSpecificOutput"]["hookEventName"],
        json!("PostToolUse")
    );
    v["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_owned()
}

const OPENED: &str =
    "\nCreating pull request for feat/x into main in o/r\n\nhttps://github.com/o/r/pull/7\n";

#[test]
fn a_pr_on_an_unreviewed_head_is_warned_and_a_reviewed_one_is_not() {
    let repo = repo();
    repo.gh_answers(&repo.head);
    let out = repo.hook("gh pr create --fill", OPENED);
    let short = short(&repo.head);
    assert_eq!(
        human(&out),
        format!(
            "craft: PR {URL} was opened with no full craft review of its head {short} (last run: none filed for feat/x)."
        )
    );
    assert!(model(&out).contains("craft:review"), "{out}");
    let args = std::fs::read_to_string(repo.bin.join("args")).unwrap();
    assert_eq!(
        args.lines().collect::<Vec<_>>(),
        [
            "pr",
            "view",
            URL,
            "--json",
            "headRefOid,baseRefName,headRefName"
        ]
    );
    repo.file_run("2026-11-01T10-00-00Z", &repo.head, &[]);
    assert_eq!(repo.hook("rtk gh pr new --fill", OPENED), Value::Null);
}

#[test]
fn a_narrower_review_of_the_head_warns_naming_it() {
    let repo = repo();
    repo.gh_answers(&repo.head);
    repo.file_run(
        "2026-11-01T10-00-00Z",
        &repo.head,
        &[("lensScope", json!("delta"))],
    );
    let said = human(&repo.hook("gh pr create", OPENED));
    let last = format!(
        "(last run: {}, Approve, delta, 2026-11-01 10:00:00 UTC)",
        short(&repo.head)
    );
    assert!(said.contains(&last), "{said}");
    // A base spelled as the commit where the head leaves origin/main is the PR's base.
    let point = git(&repo.r, &["rev-parse", "HEAD~1"]);
    repo.file_run(
        "2026-11-01T11-00-00Z",
        &repo.head,
        &[("base", json!(point))],
    );
    assert_eq!(repo.hook("gh pr create", OPENED), Value::Null);
}

#[test]
fn a_review_over_a_narrower_base_warns() {
    let repo = repo();
    repo.gh_answers(&repo.head);
    repo.file_run(
        "2026-11-01T10-00-00Z",
        &repo.head,
        &[("base", json!("HEAD"))],
    );
    assert!(human(&repo.hook("gh pr create", OPENED)).contains("no full craft review"));
}

#[test]
fn a_review_over_the_trunks_bare_name_is_read_against_origin_where_the_local_trunk_lags() {
    let repo = repo();
    git(&repo.r, &["checkout", "-q", "main"]);
    commit(&repo.r, "c");
    git(&repo.r, &["push", "-q", "origin", "main"]);
    git(&repo.r, &["checkout", "-qb", "feat/y"]);
    commit(&repo.r, "d");
    git(&repo.r, &["branch", "-f", "main", "HEAD~2"]);
    let head = git(&repo.r, &["rev-parse", "HEAD"]);
    repo.gh_answers(&head);
    repo.file_run("2026-11-01T10-00-00Z", &head, &[("base", json!("main"))]);
    assert_eq!(repo.hook("gh pr create", OPENED), Value::Null);
}

#[test]
fn a_review_of_another_commit_than_the_pr_head_does_not_count() {
    let repo = repo();
    repo.file_run("2026-11-01T10-00-00Z", &repo.head, &[]);
    commit(&repo.r, "c");
    let newer = git(&repo.r, &["rev-parse", "HEAD"]);
    repo.gh_answers(&newer);
    assert!(human(&repo.hook("gh pr create", OPENED)).contains(short(&newer)));
}

#[test]
fn other_bash_results_are_silent_and_never_ask_github() {
    let repo = repo();
    repo.gh("touch \"$0.ran\"; exit 1");
    for (command, stdout) in [
        ("git status", OPENED),
        ("gh pr create --fill", "no url here\n"),
        ("gh pr view 7", OPENED),
        (
            "echo https://github.com/o/r/issues/7 pr create",
            "https://github.com/o/r/issues/7\n",
        ),
    ] {
        assert_eq!(repo.hook(command, stdout), Value::Null, "{command}");
    }
    let edit = json!({"cwd": repo.r, "hook_event_name": "PostToolUse", "tool_name": "Write",
        "tool_input": {"command": "gh pr create"}, "tool_response": {"stdout": OPENED}});
    assert_eq!(repo.raw(&edit.to_string()), Value::Null);
    assert!(!repo.bin.join("gh.ran").exists());
}

#[test]
fn a_gh_that_fails_or_is_missing_is_a_visible_could_not_check() {
    let repo = repo();
    repo.gh("echo 'GraphQL: Could not resolve to a PullRequest' >&2; exit 1");
    let said = human(&repo.hook("gh pr create", OPENED));
    assert!(
        said.starts_with(&format!(
            "craft: could not check PR {URL} for a full craft review:"
        )),
        "{said}"
    );
    assert!(said.contains("GraphQL: Could not resolve"), "{said}");
    repo.gh("echo not json");
    assert!(human(&repo.hook("gh pr create", OPENED)).contains("could not check"));
    std::fs::remove_file(repo.bin.join("gh")).unwrap();
    let said = human(&raw_without_gh(&repo));
    assert!(
        said.contains("could not check") && said.contains("gh"),
        "{said}"
    );
}

/// The hook with a PATH that holds git and nothing named gh.
fn raw_without_gh(repo: &Repo) -> Value {
    let git_dir = Command::new("sh")
        .args(["-c", "dirname \"$(command -v git)\""])
        .output()
        .unwrap();
    let git_dir = String::from_utf8(git_dir.stdout).unwrap().trim().to_owned();
    std::fs::create_dir_all(repo.bin.join("only")).unwrap();
    std::os::unix::fs::symlink(Path::new(&git_dir).join("git"), repo.bin.join("only/git")).unwrap();
    let input = json!({"cwd": repo.r, "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "tool_input": {"command": "gh pr create"}, "tool_response": {"stdout": OPENED, "stderr": ""}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["hook", "pr-opened", "--store"])
        .arg(&repo.store)
        .env("PATH", repo.bin.join("only"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn a_head_not_in_this_checkout_is_said_and_a_missing_base_is_fetched() {
    let repo = repo();
    repo.gh_answers("3333333333333333333333333333333333333333");
    let said = human(&repo.hook("gh pr create", OPENED));
    assert!(
        said.contains("could not check") && said.contains("333333333333"),
        "{said}"
    );
    repo.gh_answers(&repo.head);
    repo.file_run("2026-11-01T10-00-00Z", &repo.head, &[]);
    git(&repo.r, &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert_eq!(
        repo.hook("gh pr create", OPENED),
        Value::Null,
        "origin/main fetched"
    );
    git(
        &repo.r,
        &["remote", "set-url", "origin", "/nonexistent/origin.git"],
    );
    git(&repo.r, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let said = human(&repo.hook("gh pr create", OPENED));
    assert!(
        said.contains("could not check") && said.contains("origin/main"),
        "{said}"
    );
}

#[test]
fn an_unreadable_store_or_input_is_said() {
    let repo = repo();
    repo.gh_answers(&repo.head);
    std::fs::create_dir_all(repo.store.join("index.jsonl")).unwrap();
    assert!(human(&repo.hook("gh pr create", OPENED)).contains("could not check"));
    assert!(
        human(&repo.raw("{not json https://github.com/o/r/pull/7")).contains("could not check")
    );
    assert_eq!(repo.raw("{not json"), Value::Null);
}

#[test]
fn a_closed_stdout_still_exits_zero() {
    let repo = repo();
    repo.gh_answers(&repo.head);
    let input = json!({"cwd": repo.r, "tool_name": "Bash", "tool_input": {"command": "gh pr create"},
        "tool_response": {"stdout": OPENED}});
    let path = format!(
        "{}:{}",
        repo.bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["hook", "pr-opened", "--store"])
        .arg(&repo.store)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
}
