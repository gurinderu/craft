//! `craft review post` and `craft pr rejections` end to end, as the addressing-findings skill runs
//! them, against a stand-in `gh` on the PATH: a chosen doubtful finding is posted with the marker
//! and its choice lands in the run's record; a PR's threads are read across pages and printed as
//! the decision records the JavaScript reader printed; what cannot be read exits 2.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};

/// `craft <args>` in `cwd` with `bin` first on the PATH and `stdin` fed.
fn craft(cwd: &Path, bin: &Path, args: &[&str], stdin: &str) -> Output {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .env("CRAFT_CODE_GRAPH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    text(&out.stdout).trim().to_owned()
}

/// A stand-in `gh` in `bin`: each call's arguments appended to `bin/calls`, then `body`.
fn gh(bin: &Path, body: &str) {
    std::fs::create_dir_all(bin).unwrap();
    let gh = bin.join("gh");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}/calls'\n{body}\n",
        bin.display()
    );
    std::fs::write(&gh, script).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/pr-rejections-cases.json"
));

fn case(name: &str) -> Value {
    let file: Value = serde_json::from_str(CASES).unwrap();
    file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == json!(name))
        .unwrap()
        .clone()
}

#[test]
fn a_prs_threads_are_asked_of_gh_and_printed_as_the_javascript_reader_printed_them() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, answer) = (dir.path().join("bin"), dir.path().join("answer.json"));
    let c = case("slurped pages");
    std::fs::write(&answer, c["answer"].to_string()).unwrap();
    gh(
        &bin,
        &format!(
            "case \"$1 $2\" in\n  \"repo view\") echo '{{\"owner\":{{\"login\":\"o\"}},\"name\":\"r\"}}' ;;\n  \"pr view\") echo '{{\"number\":9}}' ;;\n  \"api graphql\") cat '{}' ;;\n  *) exit 3 ;;\nesac",
            answer.display()
        ),
    );
    let out = craft(dir.path(), &bin, &["pr", "rejections"], "");
    assert!(out.status.success(), "{}", text(&out.stderr));
    let printed: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(printed, c["expected"]);
    assert!(text(&out.stdout).starts_with("{\n  \"decisions\": ["));
    let calls = std::fs::read_to_string(bin.join("calls")).unwrap();
    assert!(
        calls.contains("pr view --repo o/r --json number"),
        "{calls}"
    );
    assert!(
        calls.contains("api graphql --paginate --slurp -f query=query($owner:String!"),
        "{calls}"
    );
    assert!(calls.contains("-F owner=o -F name=r -F pr=9"), "{calls}");
}

#[test]
fn a_saved_answer_is_read_from_stdin_and_an_unreadable_one_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    gh(&bin, "exit 3");
    let c = case("a rejection reply records a decision");
    let out = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--threads", "-"],
        &c["answer"].to_string(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        serde_json::from_str::<Value>(&text(&out.stdout)).unwrap(),
        c["expected"]
    );
    let bad = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--threads", "-"],
        "{\"data\":{}}",
    );
    assert_eq!(bad.status.code(), Some(2));
    assert!(
        text(&bad.stderr).contains("not a reviewThreads answer"),
        "{}",
        text(&bad.stderr)
    );
    assert!(
        !bin.join("calls").exists(),
        "gh never asked for a saved answer"
    );
    let unauthenticated = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--pr", "3", "--repo", "o/r"],
        "",
    );
    assert_eq!(
        unauthenticated.status.code(),
        Some(2),
        "{}",
        text(&unauthenticated.stderr)
    );
}

#[test]
fn a_chosen_finding_is_posted_with_the_marker_and_its_choice_recorded() {
    let (dir, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = std::fs::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "feat/x"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "a"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let record = store
        .path()
        .join("2026-11-01T10-00-00Z-workflow-review.json");
    let finding = json!({"n": 1, "severity": "Medium", "title": "t", "file": "a.rs", "line": 3, "why": "w", "fix": "f", "source": "intent", "toolRule": "", "outsideDiff": false});
    let sorted = json!({"project": repo, "branch": "feat/x", "head": head, "sorting": {"defect": 0, "doubtful": 1, "inDiffJudged": true, "findings": [finding]}});
    std::fs::write(&record, serde_json::to_string_pretty(&sorted).unwrap()).unwrap();
    let bin = dir.path().join("bin");
    gh(
        &bin,
        &format!(
            "case \"$1 $2\" in\n  \"pr view\") echo '{{\"number\":5,\"url\":\"https://github.com/o/r/pull/5\",\"headRefOid\":\"{head}\"}}' ;;\n  \"api --paginate\") echo '[]' ;;\n  \"api --method\") while [ $# -gt 0 ]; do [ \"$1\" = --input ] && cp \"$2\" '{}/sent.json'; shift; done ;;\n  *) exit 3 ;;\nesac",
            bin.display()
        ),
    );
    let s = store.path().to_str().unwrap();
    let out = craft(
        &repo,
        &bin,
        &[
            "review", "post", "--n", "1", "--as", "question", "--store", s,
        ],
        "",
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let said: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(
        (&said["pr"], &said["posted"], &said["commit"]),
        (&json!(5), &json!(true), &json!(head))
    );
    assert!(
        said["recorded"]
            .as_str()
            .unwrap()
            .starts_with("recorded question for doubtful finding 1 (t @ a.rs:3)"),
        "{said}"
    );
    let sent: Value =
        serde_json::from_str(&std::fs::read_to_string(bin.join("sent.json")).unwrap()).unwrap();
    assert_eq!((&sent["path"], &sent["line"]), (&json!("a.rs"), &json!(3)));
    assert!(
        sent["body"]
            .as_str()
            .unwrap()
            .ends_with("<!-- craft-kind: question -->\n<!-- craft-finding -->")
    );
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    assert_eq!(r["sorting"]["choices"]["1"]["choice"], json!("question"));
    let none = craft(
        &repo,
        &bin,
        &["review", "post", "--n", "9", "--as", "defect", "--store", s],
        "",
    );
    assert_eq!(none.status.code(), Some(2));
    assert!(
        text(&none.stderr).contains("the run record lists no doubtful finding numbered 9"),
        "{}",
        text(&none.stderr)
    );
}
