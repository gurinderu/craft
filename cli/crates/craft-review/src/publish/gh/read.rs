//! What the pull request already holds: which it is, at which head, and the craft finding comments
//! on it, read with `gh` before anything is posted.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::gh;
use crate::gate::runner::Runner;
use crate::publish::body::{self, MARKER};

/// The pull request of the checked-out branch, as `gh pr view` names it.
pub(super) struct Pr {
    pub(super) number: u64,
    pub(super) url: String,
    pub(super) head: String,
}

/// The checked-out branch's pull request.
pub(super) fn pull_request(runner: &Runner, repo: &Path) -> Result<Pr, String> {
    let out = gh(
        runner,
        repo,
        &["pr", "view", "--json", "number,url,headRefOid"],
    )
    .map_err(|e| {
        if e.starts_with("gh pr view failed") {
            format!("{e} (no pull request for the checked-out branch, or gh is not authenticated)")
        } else {
            e
        }
    })?;
    let v: Value =
        serde_json::from_str(&out).map_err(|e| format!("gh pr view printed no JSON: {e}"))?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let number = v.get("number").and_then(Value::as_u64).unwrap_or(0);
    if number == 0 {
        return Err("gh pr view named no pull request number".into());
    }
    Ok(Pr {
        number,
        url: text("url"),
        head: text("headRefOid"),
    })
}

/// The craft finding comments already on the pull request, by file and first line. `--paginate`
/// prints the pages as one array (gh 2.102, observed) or, in older releases, one array after
/// another: read here as a stream of values, either way.
pub(super) fn posted_already(
    runner: &Runner,
    repo: &Path,
    pr: u64,
) -> Result<BTreeSet<(String, String)>, String> {
    let route = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments");
    let out = gh(runner, repo, &["api", "--paginate", &route])?;
    let mut keys = BTreeSet::new();
    for page in serde_json::Deserializer::from_str(&out).into_iter::<Value>() {
        let page =
            page.map_err(|e| format!("gh api printed no JSON for the PR's comments: {e}"))?;
        for c in page.as_array().into_iter().flatten() {
            let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
            if text("body").contains(MARKER) {
                keys.insert((
                    text("path").to_owned(),
                    body::first_line(text("body")).to_owned(),
                ));
            }
        }
    }
    Ok(keys)
}
