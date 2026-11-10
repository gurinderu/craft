//! A stand-in `gh` for the pull request a detached `HEAD` heads: it logs each call, answers
//! `pr list` with the text of `dir/list` and `pr view` with that of `dir/view`, and fails every
//! call while `dir/fail` exists — never a real pull request.
#![expect(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

use std::path::Path;
use std::time::Duration;

use craft_review::chain;
use craft_review::publish::PostSetup;
use craft_review::step;
use serde_json::{Value, json};

/// The stand-in in `dir`, answering `pr list` with `list` and `pr view` with `view`.
pub fn pr_gh(dir: &Path, list: &str, view: &str) -> PostSetup {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("list"), list).unwrap();
    std::fs::write(dir.join("view"), view).unwrap();
    let s = dir.display();
    let script = format!(
        r#"#!/bin/sh
S='{s}'
echo "$*" >> "$S/calls"
if [ -f "$S/fail" ]; then echo "HTTP 401: Bad credentials (https://api.github.com)" >&2; exit 1; fi
case "$1 $2" in
  "pr list") cat "$S/list" ;;
  "pr view") cat "$S/view" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#
    );
    super::exe::write_executable(&dir.join("gh"), &script).unwrap();
    let path = std::env::join_paths(
        std::iter::once(dir.to_path_buf())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    PostSetup {
        budget: Duration::from_secs(30),
        path: Some(path),
    }
}

/// The calls the stand-in in `dir` was asked, one per line.
pub fn calls(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("calls")).unwrap_or_default()
}

/// The commit `r` names in `repo`.
pub fn rev(repo: &Path, r: &str) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", r])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A same-repository pull request as gh prints the fields the chain asks for.
pub fn pr(number: u64, branch: &str, oid: &str) -> Value {
    json!({"number": number, "headRefName": branch, "headRefOid": oid, "isCrossRepository": false})
}

/// A pull request from `owner`'s fork, its head branch `branch`.
pub fn fork_pr(number: u64, owner: &str, branch: &str, oid: &str) -> Value {
    let mut p = pr(number, branch, oid);
    p["isCrossRepository"] = json!(true);
    p["headRepositoryOwner"] = json!({"id": "U_1", "login": owner, "name": owner});
    p
}

/// A fixture on a detached `HEAD`, with round 1 of `main` filed in `runs/r1` at `HEAD~1`.
pub fn detached(runs: &Path) -> tempfile::TempDir {
    let repo = super::fixture(true);
    let r1 = runs.join("r1");
    std::fs::create_dir_all(&r1).unwrap();
    let common = craft_review::git::common_dir(repo.path()).unwrap();
    let record = chain::record(&common, "main", &rev(repo.path(), "HEAD~1"), 1, vec![]);
    chain::file_record(&r1, &record).unwrap();
    super::git(repo.path(), &["checkout", "-q", "--detach"]);
    repo
}

/// The run in `run`, its step `s`, driven to its end, its lenses finding nothing.
pub fn to_end(run: &Path, mut s: Value) -> Value {
    for _ in 0..12 {
        if s["done"] == json!(true) {
            return s;
        }
        s = step::submit(run, Some(&super::post::answers(&s, &[]))).unwrap();
    }
    panic!("the run did not finish: {s}")
}
