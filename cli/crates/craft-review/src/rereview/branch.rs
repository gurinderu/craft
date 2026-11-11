//! The branch a run's round chain is keyed on. On a detached `HEAD` git names none, which left every
//! run there a round 1 that carried nothing to the next (realm @nick/craft, node #104) — and a
//! consumer that reviews each pull request in a detached worktree never had its re-review memory
//! (node #89). There the chain takes the head branch of the pull request `HEAD` heads, so a run on
//! the branch and a run in a detached worktree of its PR build on each other.
//! A fork's PR keys it on `<owner>:<head branch>` instead ([`pr`]), so it joins no local branch.
//! A pull request given (`pr=`) is checked first: `HEAD` must be or hold its head ([`head`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::gate::runner::Runner;
use crate::git;
use crate::publish::PostSetup;

mod head;
mod pr;

use pr::{Named, given, heading};

/// How long asking gh for the pull request may take: the run waits for it before its first task.
const BUDGET: Duration = Duration::from_secs(20);

/// What gh is asked: the pull request given (`pr`), whose head `HEAD` must be or hold, else, on a
/// detached `HEAD`, the open one whose head is `HEAD`; `gh` `None`, it is not asked. Its output is
/// kept in `dir`.
#[derive(Debug, Clone)]
pub struct Lookup<'a> {
    pub pr: Option<u64>,
    pub gh: Option<&'a PostSetup>,
    pub dir: PathBuf,
}

/// The chain's branch, and where it came from or why there is none: `name` with `from` when a
/// pull request named it, `None` with `why` when nothing did; neither said for a checked-out one.
/// `pr` is the pull request under review: the one given, else the one that named `name`. `note`
/// says a given PR's head went unchecked, gh asked but not telling.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChainBranch {
    pub name: Option<String>,
    pub from: Option<String>,
    pub why: Option<String>,
    pub pr: Option<u64>,
    pub note: Option<String>,
}

/// The branch `cwd`'s run is chained on.
///
/// # Errors
/// The refusal, when a pull request is given and `HEAD` does not hold the head gh names for it
/// (realm @nick/craft, node #468).
pub fn resolve(cwd: &Path, lookup: Lookup<'_>) -> Result<ChainBranch, String> {
    let branch = git::branch(cwd);
    if lookup.pr.is_none() && branch.is_some() {
        return Ok(ChainBranch {
            name: branch,
            ..ChainBranch::default()
        });
    }
    let Asked { found, ahead } = ask(cwd, &lookup)?;
    let unchecked = lookup.pr.filter(|_| lookup.gh.is_some());
    let mut chain = chained(branch, lookup.pr, unchecked, found);
    chain.note = chain.note.or(ahead);
    Ok(chain)
}

/// What gh said: the pull request that names the chain, or why none does; and, `HEAD` ahead of a
/// given PR's head, the note saying so.
struct Asked {
    found: Result<Named, String>,
    ahead: Option<String>,
}

/// What gh says of the pull request: the one given, refused when `HEAD` does not hold its head,
/// else the one `HEAD` heads.
fn ask(cwd: &Path, lookup: &Lookup<'_>) -> Result<Asked, String> {
    let none = |why: String| Asked {
        found: Err(why),
        ahead: None,
    };
    let (setup, head) = match (lookup.gh, git::git(cwd, &["rev-parse", "HEAD"])) {
        (None, _) => {
            return Ok(none(
                "gh was not asked which pull request this HEAD heads".to_owned(),
            ));
        }
        (_, Err(e)) => return Ok(none(format!("git could not name HEAD: {e}"))),
        (Some(setup), Ok(head)) => (setup, head.trim().to_owned()),
    };
    let runner = Runner::new(
        setup.budget.min(BUDGET),
        setup.path.clone(),
        lookup.dir.clone(),
    );
    let Some(n) = lookup.pr else {
        return Ok(Asked {
            found: heading(&runner, cwd, &head),
            ahead: None,
        });
    };
    let found = given(&runner, cwd, n);
    let ahead = match &found {
        Ok(named) if !named.head.is_empty() => head::check(cwd, n, &named.head, &head)?,
        _ => None,
    };
    Ok(Asked { found, ahead })
}

/// The chain `found` names: the checked-out `branch` whatever gh said, else the PR's branch, else
/// none and why; a given PR (`unchecked`, gh asked) gh could not tell of is noted.
fn chained(
    branch: Option<String>,
    pr: Option<u64>,
    unchecked: Option<u64>,
    found: Result<Named, String>,
) -> ChainBranch {
    let note = |why: &str| {
        unchecked.map(|n| {
            format!("pr={n}: PR #{n}'s head was not checked against HEAD, so this checkout was reviewed as it is: {why}")
        })
    };
    match (branch, found) {
        (Some(name), found) => ChainBranch {
            name: Some(name),
            pr,
            note: found.err().and_then(|why| note(&why)),
            ..ChainBranch::default()
        },
        (None, Ok(Named { name, from, pr, .. })) => ChainBranch {
            name: Some(name),
            from: Some(from),
            pr: Some(pr),
            ..ChainBranch::default()
        },
        (None, Err(why)) => ChainBranch {
            note: note(&why),
            why: Some(why),
            pr,
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
