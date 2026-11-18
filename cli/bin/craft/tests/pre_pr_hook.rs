//! `craft hook pre-pr` as the harness runs it: the `PreToolUse` input on stdin, a real repository,
//! a run store as the record writer lays it out; the output read back as the harness reads it.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

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

/// A repository whose `origin/main` is its first commit, on `feat/x` one commit past it; that HEAD.
fn repo(d: &Path) -> String {
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("a"), "a\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(d, &["checkout", "-qb", "feat/x"]);
    std::fs::write(d.join("b"), "b\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "b"]);
    git(d, &["rev-parse", "HEAD"])
}

/// Files a review run into `store` as the record writer does: an index line and its detail file,
/// a full review of the whole change with its lenses run unless `scope` says `delta`.
fn file_run(store: &Path, project: &Path, at: (&str, &str), verdict: &str, scope: &str) {
    let (ts, head) = at;
    std::fs::create_dir_all(store).unwrap();
    let line = json!({"ts": ts, "kind": "workflow", "name": "review", "nested": false,
        "project": project.canonicalize().unwrap(), "branch": "feat/x", "head": head,
        "verdict": verdict, "dirty": false});
    let mut detail = line.clone();
    for (k, v) in [
        ("lensScope", json!(scope)),
        ("depth", json!("full")),
        ("path", json!("")),
        ("base", json!("origin/main")),
        ("notRun", json!([])),
        ("lensRounds", json!([{}])),
    ] {
        detail[k] = v;
    }
    let mut index = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(store.join("index.jsonl"))
        .unwrap();
    writeln!(index, "{line}").unwrap();
    std::fs::write(
        store.join(format!("{ts}-workflow-review.json")),
        detail.to_string(),
    )
    .unwrap();
}

fn input(cwd: &Path, command: &str) -> String {
    json!({"session_id": "s", "transcript_path": "/t", "cwd": cwd,
        "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": command}, "tool_use_id": "u"})
    .to_string()
}

/// The hook run on `command` from `cwd`; its stdout parsed, `null` when empty.
fn hook(cwd: &Path, store: &Path, command: &str) -> Value {
    raw(store, &input(cwd, command))
}

/// The hook run on the raw stdin `stdin`; its stdout parsed, `null` when empty.
fn raw(store: &Path, stdin: &str) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["hook", "pre-pr", "--store"])
        .arg(store)
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

fn human(v: &Value) -> String {
    v["systemMessage"].as_str().unwrap().to_owned()
}

#[test]
fn a_pr_on_an_unreviewed_head_is_warned_and_a_reviewed_one_is_not() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path().join("r");
    std::fs::create_dir(&r).unwrap();
    let head = repo(&r);
    let store = d.path().join("store");

    assert_eq!(
        hook(&r, &store, "git status"),
        Value::Null,
        "not a PR: silent"
    );
    let warned = hook(&r, &store, "rtk gh pr create --fill");
    assert!(
        human(&warned).contains("no craft review is filed for feat/x"),
        "no store yet: {warned}"
    );

    file_run(
        &store,
        &r,
        ("2026-11-01T10-00-00Z", &head),
        "Warning",
        "delta",
    );
    let warned = hook(&r, &store, "gh pr create --fill");
    assert_eq!(warned["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    let human = warned["systemMessage"].as_str().unwrap();
    assert!(
        human.contains("opening a PR with no full craft review on this head"),
        "{human}"
    );
    assert!(human.contains(head.get(..12).unwrap()), "{human}");
    assert!(human.contains("Warning, delta"), "{human}");

    file_run(&store, &r, ("2026-11-01T11-00-00Z", &head), "Block", "full");
    assert_eq!(
        hook(&r, &store, "gh pr create --fill"),
        Value::Null,
        "reviewed: silent"
    );
}

#[test]
fn a_linked_worktree_finds_the_run_filed_under_its_main_checkout() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path().join("r");
    std::fs::create_dir(&r).unwrap();
    repo(&r);
    let wt = d.path().join("wt");
    git(
        &r,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/y",
            wt.to_str().unwrap(),
        ],
    );
    std::fs::write(wt.join("w"), "w\n").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-qm", "w"]);
    let store = d.path().join("store");
    let wt_head = git(&wt, &["rev-parse", "HEAD"]);
    file_run(
        &store,
        &r,
        ("2026-11-01T10-00-00Z", &wt_head),
        "Approve",
        "full",
    );
    assert!(
        !hook(&r, &store, "gh pr create").is_null(),
        "the main checkout's head is another"
    );
    assert_eq!(hook(&r, &store, "cd ../wt && gh pr create"), Value::Null);
    let from_elsewhere = format!("cd {} && gh pr create", wt.display());
    assert_eq!(hook(d.path(), &store, &from_elsewhere), Value::Null);
}

/// A repository on `feat/x` with its run store; the directory, the store and the head.
fn reviewed_repo(d: &Path) -> (std::path::PathBuf, std::path::PathBuf, String) {
    let r = d.join("r");
    std::fs::create_dir(&r).unwrap();
    let head = repo(&r);
    let store = d.join("store");
    file_run(
        &store,
        &r,
        ("2026-11-01T10-00-00Z", &head),
        "Approve",
        "full",
    );
    (r, store, head)
}

#[test]
fn a_head_branch_is_judged_on_its_own_tip_and_named() {
    let d = tempfile::tempdir().unwrap();
    let (r, store, _) = reviewed_repo(d.path());
    assert_eq!(hook(&r, &store, "gh pr create --head feat/x"), Value::Null);
    git(&r, &["branch", "feat/y", "main"]);
    std::fs::write(r.join("c"), "c\n").unwrap();
    git(&r, &["checkout", "-q", "feat/y"]);
    git(&r, &["add", "."]);
    git(&r, &["commit", "-qm", "c"]);
    git(&r, &["checkout", "-q", "feat/x"]);
    let tip = git(&r, &["rev-parse", "feat/y"]);
    let said = human(&hook(&r, &store, "gh pr create -H me:feat/y"));
    assert!(
        said.contains(&format!(
            "{}, the tip of feat/y that --head names",
            tip.get(..12).unwrap()
        )),
        "{said}"
    );
    git(&r, &["update-ref", "refs/remotes/origin/feat/z", &tip]);
    let said = human(&hook(&r, &store, "gh pr create --head feat/z"));
    assert!(
        said.contains("the tip of feat/z that --head names"),
        "only on origin: {said}"
    );
    let said = human(&hook(&r, &store, "gh pr create --head nope"));
    assert!(
        said.contains("could not check") && said.contains("nope"),
        "{said}"
    );
}

#[test]
fn a_chain_that_moves_head_first_is_said_not_judged() {
    let d = tempfile::tempdir().unwrap();
    let (r, store, _) = reviewed_repo(d.path());
    let said = human(&hook(
        &r,
        &store,
        "git commit -qam x && gh pr create --fill",
    ));
    assert!(
        said.contains("the command changes the branch first (`git commit`)"),
        "{said}"
    );
}

#[test]
fn every_doubt_is_a_visible_line() {
    let d = tempfile::tempdir().unwrap();
    let (r, store, _) = reviewed_repo(d.path());
    for (command, why) in [
        ("cd $WT && gh pr create", "shell expansion"),
        ("cd ../nowhere && gh pr create", "git cannot read HEAD"),
    ] {
        let said = human(&hook(&r, &store, command));
        assert!(
            said.contains("could not check") && said.contains(why),
            "{command}: {said}"
        );
    }
    git(&r, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let said = human(&hook(&r, &store, "gh pr create"));
    assert!(
        said.contains("could not check") && said.contains("origin"),
        "{said}"
    );
    let said = human(&raw(
        &store,
        "{\"tool_input\": {\"command\": \"gh pr create\"",
    ));
    assert!(said.contains("the hook input is not JSON"), "{said}");
    assert_eq!(
        raw(&store, "not json at all"),
        Value::Null,
        "clearly not ours"
    );
    assert_eq!(raw(&store, "{\"tool_name\": \"Read\"}"), Value::Null);
}

#[test]
fn a_closed_stdout_still_exits_zero() {
    let d = tempfile::tempdir().unwrap();
    let (r, store, _) = reviewed_repo(d.path());
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["hook", "pre-pr", "--store"])
        .arg(&store)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let stdin = input(&r, "cd $X && gh pr create");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
}
