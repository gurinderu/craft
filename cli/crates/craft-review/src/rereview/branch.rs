//! The branch a run's round chain is keyed on. On a detached `HEAD` git names none, which left every
//! run there a round 1 that carried nothing to the next (realm @nick/craft, node #104) — and a
//! consumer that reviews each pull request in a detached worktree never had its re-review memory
//! (node #89). There the chain takes the head branch of the pull request `HEAD` heads, so a run on
//! the branch and a run in a detached worktree of its PR build on each other.
//! A fork's PR keys it on `<owner>:<head branch>` instead ([`pr`]), so it joins no local branch.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::gate::runner::Runner;
use crate::git;
use crate::publish::PostSetup;

mod pr;

use pr::{Named, given, heading};

/// How long asking gh for the pull request may take: the run waits for it before its first task.
const BUDGET: Duration = Duration::from_secs(20);

/// What gh is asked on a detached `HEAD`: the pull request given (`pr`), else the open one whose
/// head is `HEAD`; `gh` `None`, it is not asked. Its output is kept in `dir`.
#[derive(Debug, Clone)]
pub struct Lookup<'a> {
    pub pr: Option<u64>,
    pub gh: Option<&'a PostSetup>,
    pub dir: PathBuf,
}

/// The chain's branch, and where it came from or why there is none: `name` with `from` when a
/// pull request named it, `None` with `why` when nothing did; neither said for a checked-out one.
/// `pr` is the pull request under review: the one given, else the one that named `name`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChainBranch {
    pub name: Option<String>,
    pub from: Option<String>,
    pub why: Option<String>,
    pub pr: Option<u64>,
}

/// The branch `cwd`'s run is chained on.
#[must_use]
pub fn resolve(cwd: &Path, lookup: Lookup<'_>) -> ChainBranch {
    if let Some(name) = git::branch(cwd) {
        return ChainBranch {
            name: Some(name),
            pr: lookup.pr,
            ..ChainBranch::default()
        };
    }
    let found = match (lookup.gh, git::git(cwd, &["rev-parse", "HEAD"])) {
        (None, _) => Err("gh was not asked which pull request this HEAD heads".to_owned()),
        (_, Err(e)) => Err(format!("git could not name HEAD: {e}")),
        (Some(setup), Ok(head)) => {
            let runner = Runner::new(setup.budget.min(BUDGET), setup.path.clone(), lookup.dir);
            match lookup.pr {
                Some(n) => given(&runner, cwd, n),
                None => heading(&runner, cwd, head.trim()),
            }
        }
    };
    match found {
        Ok(Named { name, from, pr }) => ChainBranch {
            name: Some(name),
            from: Some(from),
            why: None,
            pr: Some(pr),
        },
        Err(why) => ChainBranch {
            why: Some(why),
            pr: lookup.pr,
            ..ChainBranch::default()
        },
    }
}

/// Why a run builds on no prior round, as the report names it: on a detached `HEAD` no pull
/// request named, with why none did.
#[must_use]
pub fn unchained(why: crate::chain::Unchained, branch: &ChainBranch) -> String {
    match (why, branch.why.as_deref()) {
        (crate::chain::Unchained::NoBranch, Some(detail)) => format!("{}; {detail}", why.reason()),
        _ => why.reason().to_owned(),
    }
}
