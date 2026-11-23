//! What the pull request already holds: which it is, at which head, and the craft finding comments
//! on it, read with `gh` before anything is posted.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::gh;
use crate::gate::runner::Runner;
use crate::publish::body::{self, MARKER};

/// The pull request of the checked-out branch, as `gh pr view` names it.
pub(in crate::publish) struct Pr {
    pub(in crate::publish) number: u64,
    pub(in crate::publish) url: String,
    pub(in crate::publish) head: String,
    /// Its head branch, '' when gh did not say.
    pub(in crate::publish) head_ref: String,
    /// Its head is in a fork (`isCrossRepository`; false when gh did not say).
    pub(in crate::publish) cross_repository: bool,
    /// `OPEN`, `CLOSED` or `MERGED`; '' when gh did not say.
    pub(in crate::publish) state: String,
}

/// The fields every pull request is read with.
const FIELDS: &str =
    "number,url,headRefOid,headRefName,isCrossRepository,headRepositoryOwner,state";

/// A pull request as gh prints it.
fn pr_of(v: &Value) -> Result<Pr, String> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let number = v.get("number").and_then(Value::as_u64).unwrap_or(0);
    if number == 0 {
        return Err("gh named no pull request number".into());
    }
    Ok(Pr {
        number,
        url: text("url"),
        head: text("headRefOid"),
        head_ref: text("headRefName"),
        cross_repository: v.get("isCrossRepository").and_then(Value::as_bool) == Some(true),
        state: text("state"),
    })
}

/// The open pull requests whose head branch is `branch`.
pub(in crate::publish) fn open_prs(
    runner: &Runner,
    repo: &Path,
    branch: &str,
) -> Result<Vec<Pr>, String> {
    if branch.starts_with('-') {
        return Err(format!("{branch:?} is no branch name"));
    }
    let args = [
        "pr", "list", "--head", branch, "--state", "open", "--json", FIELDS,
    ];
    let out = gh(runner, repo, &args)?;
    let v: Value =
        serde_json::from_str(&out).map_err(|e| format!("gh pr list printed no JSON: {e}"))?;
    v.as_array()
        .ok_or_else(|| "gh pr list printed no list".to_owned())?
        .iter()
        .map(pr_of)
        .collect()
}

/// The pull request `which` names — its number, or a branch whose pull request it is — the
/// checked-out branch's when `None`.
pub(in crate::publish) fn pull_request(
    runner: &Runner,
    repo: &Path,
    which: Option<&str>,
) -> Result<Pr, String> {
    let mut args = vec!["pr", "view"];
    args.extend(which.filter(|b| !b.starts_with('-')));
    args.extend(["--json", FIELDS]);
    let out = gh(runner, repo, &args).map_err(|e| {
        if e.starts_with("gh pr view failed") {
            format!("{e} (no pull request for the checked-out branch, or gh is not authenticated)")
        } else {
            e
        }
    })?;
    let v: Value =
        serde_json::from_str(&out).map_err(|e| format!("gh pr view printed no JSON: {e}"))?;
    pr_of(&v)
}

/// A posted comment's identity: its file, its line (0 for a comment on the file) and its first
/// line, `[Severity] title` — two findings sharing a title on one file are told apart by line.
pub(in crate::publish) type Key = (String, u64, String);

/// The craft finding comments already on the pull request, by file, line and first line: each
/// under the line GitHub keeps for the comment now and under the one it was posted on
/// (`original_line`, which differs once the diff moved under it, or a comment was posted on an
/// earlier commit), 0 for a comment on its file. `--paginate`
/// prints the pages as one array (gh 2.102, observed) or, in older releases, one array after
/// another: read here as a stream of values, either way.
pub(in crate::publish) fn posted_already(
    runner: &Runner,
    repo: &Path,
    pr: u64,
) -> Result<BTreeSet<Key>, String> {
    let route = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments");
    let out = gh(runner, repo, &["api", "--paginate", &route])?;
    let mut keys = BTreeSet::new();
    for page in serde_json::Deserializer::from_str(&out).into_iter::<Value>() {
        let page =
            page.map_err(|e| format!("gh api printed no JSON for the PR's comments: {e}"))?;
        for c in page.as_array().into_iter().flatten() {
            let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
            if !text("body").contains(MARKER) {
                continue;
            }
            let lines: Vec<u64> = ["line", "original_line"]
                .iter()
                .filter_map(|k| c.get(*k).and_then(Value::as_u64))
                .collect();
            let first = body::first_line(text("body"));
            for line in if lines.is_empty() { vec![0] } else { lines } {
                keys.insert((text("path").to_owned(), line, first.to_owned()));
            }
        }
    }
    Ok(keys)
}
