//! Posting the defects on the PR with `gh`, run by the binary itself as it runs git and the gate's
//! tools: every call bounded by what is left of one budget, its output in files of the run's
//! `publish/` directory. A comment already on the PR — one carrying the craft-finding marker, on
//! the same file and line (or on the file, where a line GitHub refused put it), with the same
//! `[Severity] title` first line — is not posted again, so a second run over the same head adds
//! nothing. Whatever gh does, the review's verdict stands: a failure is named in the outcome, never
//! raised.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use super::body;
use super::{Defect, Posted};
use crate::gate::runner::{Ran, Runner};

mod read;
mod send;

use read::{Key, posted_already, pull_request};
use send::To;

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

/// What a post when the PR's head is not the reviewed head does: names why it posts nothing
/// (`Skip`, the outcome a finished run reports), posts on the reviewed commit and says how the head
/// moved (`Post`), or is refused (`Refuse`), nothing posted and nothing kept.
pub(super) enum Moved {
    Skip(String),
    Post(String),
    Refuse(String),
}

/// Where the defects go: the reviewed head they are posted on, the branch whose pull request it is
/// (`None`: the checked-out one's), and what a PR at another head does.
pub(super) struct Target<'a> {
    pub(super) head: &'a str,
    pub(super) branch: Option<&'a str>,
    pub(super) moved: &'a dyn Fn(&str) -> Moved,
}

/// Posts `defects` on the pull request of `target`'s branch in `repo`; `Err` only when a moved
/// head refuses it.
pub(super) fn post(
    repo: &Path,
    target: &Target<'_>,
    defects: &[Defect],
    dir: &Path,
    setup: &PostSetup,
) -> Result<Posted, String> {
    let mut p = Posted {
        requested: defects.len(),
        ..Posted::default()
    };
    let dir = dir.join("publish");
    let runner = Runner::new(setup.budget, setup.path.clone(), dir.clone());
    let pr = match pull_request(&runner, repo, target.branch) {
        Ok(pr) => pr,
        Err(e) => return Ok(p.failed_with(e)),
    };
    (p.pr, p.url) = (pr.number, pr.url.clone());
    let note = if pr.head == target.head {
        String::new()
    } else {
        match (target.moved)(&pr.head) {
            Moved::Post(note) => format!(" · {note}"),
            Moved::Skip(reason) => {
                p.reason = reason;
                return Ok(p);
            }
            Moved::Refuse(why) => return Err(why),
        }
    };
    let mut seen = match posted_already(&runner, repo, pr.number) {
        Ok(k) => k,
        Err(e) => {
            return Ok(p.failed_with(format!(
                "{e} — nothing posted, since what is there already could not be read"
            )));
        }
    };
    let to = To {
        runner: &runner,
        repo,
        dir: &dir,
        pr: pr.number,
        head: target.head,
    };
    for (n, d) in defects.iter().enumerate() {
        post_new(&to, n + 1, d, &mut seen, &mut p);
    }
    p.reason = format!("PR #{} {}{note}", pr.number, pr.url);
    Ok(p)
}

/// Posts defect `n` unless a craft finding comment of it is on the PR already — on its line, or on
/// its file, where a refused line put it — and counts what came of it.
fn post_new(to: &To<'_>, n: usize, d: &Defect, seen: &mut BTreeSet<Key>, p: &mut Posted) {
    let body = body::defect(&d.finding);
    let first = body::first_line(&body).to_owned();
    let on_file = (d.file.clone(), 0, first.clone());
    let at = (d.file.clone(), d.line.map_or(0, u64::from), first);
    if seen.contains(&on_file) || !seen.insert(at) {
        p.already += 1;
        return;
    }
    match to.defect(n, d, &body) {
        Ok(to_file) => {
            p.posted += 1;
            if to_file {
                p.to_file += 1;
                seen.insert(on_file);
            }
        }
        Err(e) => {
            p.failed += 1;
            if p.error.is_empty() {
                p.error = e;
            }
        }
    }
}
