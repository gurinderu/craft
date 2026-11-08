//! Posting the defects on the PR with `gh`, run by the binary itself as it runs git and the gate's
//! tools: every call bounded by what is left of one budget, its output in files of the run's
//! `publish/` directory. A comment already on the PR — one carrying the craft-finding marker, on
//! the same file, with the same `[Severity] title` first line — is not posted again, so a second
//! run over the same head adds nothing. Whatever gh does, the review's verdict stands: a failure is
//! named in the outcome, never raised.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::body;
use super::{Defect, Posted};
use crate::gate::runner::{Ran, Runner};

mod read;

use read::{posted_already, pull_request};

/// How long all of a run's gh calls may take: well inside the two minutes the driver's service
/// agent gives the submit's command by default, beside the submit's own work.
const BUDGET: Duration = Duration::from_secs(75);

/// How the defects are posted.
#[derive(Debug, Clone)]
pub struct PostSetup {
    /// How long all the gh calls may run.
    pub budget: Duration,
    /// The PATH gh is looked up on, when not craft's own.
    pub path: Option<OsString>,
}

impl Default for PostSetup {
    fn default() -> Self {
        Self {
            budget: BUDGET,
            path: None,
        }
    }
}

/// Runs `gh args` in `repo`: its stdout, or why it gave none.
pub(super) fn gh(runner: &Runner, repo: &Path, args: &[&str]) -> Result<String, String> {
    let what = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    match runner.run(repo, "gh", args) {
        Ran::Exited { ok: true, out, .. } => Ok(out),
        Ran::Exited { err, .. } => Err(format!(
            "gh {what} failed: {}",
            err.lines().next().unwrap_or("no message").trim()
        )),
        Ran::Missing => Err("gh is not installed (no `gh` on the PATH)".into()),
        Ran::TimedOut(_) => Err(format!(
            "gh {what} did not finish within the posting budget"
        )),
        Ran::Broken(e) => Err(format!("gh {what} could not run: {e}")),
    }
}

/// The request of one review comment (REST `POST /repos/{owner}/{repo}/pulls/{pr}/comments`, as
/// `findingPostRequest` builds it): on its line when the diff changed it, else on its file.
fn request(d: &Defect, head: &str, body: &str) -> Value {
    match d.line {
        Some(line) => {
            json!({"commit_id": head, "path": d.file, "line": line, "side": "RIGHT", "body": body})
        }
        None => json!({"commit_id": head, "path": d.file, "subject_type": "file", "body": body}),
    }
}

/// Posts one comment through a request file in `dir`.
fn post_one(
    runner: &Runner,
    repo: &Path,
    dir: &Path,
    pr: u64,
    n: usize,
    req: &Value,
) -> Result<(), String> {
    let file = dir.join(format!("comment-{n}.json"));
    std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&file, req.to_string()))
        .map_err(|e| format!("writing {}: {e}", file.display()))?;
    let route = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/comments");
    let input = file.display().to_string();
    gh(
        runner,
        repo,
        &["api", "--method", "POST", &route, "--input", &input],
    )
    .map(|_| ())
}

/// Posts `defects` on the pull request of the branch checked out in `repo`, reviewed at `head`.
pub(super) fn post(
    repo: &Path,
    head: &str,
    defects: &[Defect],
    dir: &Path,
    setup: &PostSetup,
) -> Posted {
    let mut p = Posted {
        requested: defects.len(),
        ..Posted::default()
    };
    let dir = dir.join("publish");
    let runner = Runner::new(setup.budget, setup.path.clone(), dir.clone());
    let pr = match pull_request(&runner, repo) {
        Ok(pr) => pr,
        Err(e) => return p.failed_with(e),
    };
    (p.pr, p.url) = (pr.number, pr.url.clone());
    if pr.head != head {
        let short = |s: &str| s.get(..12).unwrap_or(s).to_owned();
        p.reason = format!(
            "the PR's head {} is not the reviewed head {}: push the branch and review again",
            short(&pr.head),
            short(head)
        );
        return p;
    }
    let mut seen = match posted_already(&runner, repo, pr.number) {
        Ok(k) => k,
        Err(e) => {
            return p.failed_with(format!(
                "{e} — nothing posted, since what is there already could not be read"
            ));
        }
    };
    for (n, d) in defects.iter().enumerate() {
        let body = body::defect(&d.finding);
        if !seen.insert((d.file.clone(), body::first_line(&body).to_owned())) {
            p.already += 1;
            continue;
        }
        match post_one(
            &runner,
            repo,
            &dir,
            pr.number,
            n + 1,
            &request(d, head, &body),
        ) {
            Ok(()) => p.posted += 1,
            Err(e) => {
                p.failed += 1;
                if p.error.is_empty() {
                    p.error = e;
                }
            }
        }
    }
    p.reason = format!("PR #{} {}", pr.number, pr.url);
    p
}
