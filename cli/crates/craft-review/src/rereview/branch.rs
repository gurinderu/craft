//! The branch a run's round chain is keyed on. On a detached `HEAD` git names none, which left every
//! run there a round 1 that carried nothing to the next (realm @nick/craft, node #104) — and a
//! consumer that reviews each pull request in a detached worktree never had its re-review memory
//! (node #89). There the chain takes the head branch of the pull request `HEAD` heads, so a run on
//! the branch and a run in a detached worktree of its PR build on each other.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::gate::runner::Runner;
use crate::gh::gh;
use crate::git;
use crate::publish::PostSetup;

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
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChainBranch {
    pub name: Option<String>,
    pub from: Option<String>,
    pub why: Option<String>,
}

/// The branch `cwd`'s run is chained on.
#[must_use]
pub fn resolve(cwd: &Path, lookup: Lookup<'_>) -> ChainBranch {
    if let Some(name) = git::branch(cwd) {
        return ChainBranch {
            name: Some(name),
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
    let (name, from, why) = match found {
        Ok((name, from)) => (Some(name), Some(from), None),
        Err(why) => (None, None, Some(why)),
    };
    ChainBranch { name, from, why }
}

/// The fields gh is asked for a pull request.
const FIELDS: &str = "number,headRefName,headRefOid";

/// The head branch of pull request `n`, given (`pr`): it names the chain whatever its head is now,
/// as the ancestry check keeps a round of a rewritten history out of it.
fn given(runner: &Runner, cwd: &Path, n: u64) -> Result<(String, String), String> {
    let v = ask(
        runner,
        cwd,
        &["pr", "view", &n.to_string(), "--json", FIELDS],
    )?;
    named(&v, &format!("pr={n}, detached HEAD"))
}

/// The head branch of the one open pull request whose head is `head`: a search by the commit also
/// finds a PR that only contains it, so a PR at another head is not taken, nor one of several.
fn heading(runner: &Runner, cwd: &Path, head: &str) -> Result<(String, String), String> {
    let v = ask(
        runner,
        cwd,
        &[
            "pr", "list", "--search", head, "--state", "open", "--json", FIELDS,
        ],
    )?;
    let at_head: Vec<&Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p.get("headRefOid").and_then(Value::as_str) == Some(head))
        .collect();
    let short = head.get(..12).unwrap_or(head);
    match at_head.as_slice() {
        [] => Err(format!(
            "no open pull request has this HEAD (`{short}`) as its head"
        )),
        [one] => named(one, "detached HEAD"),
        several => {
            let n: Vec<String> = several.iter().map(|p| format!("#{}", number(p))).collect();
            Err(format!(
                "{} open pull requests ({}) have this HEAD (`{short}`) as their head, so none names the chain",
                n.len(),
                n.join(", ")
            ))
        }
    }
}

/// What gh printed for `args`, as JSON.
fn ask(runner: &Runner, cwd: &Path, args: &[&str]) -> Result<Value, String> {
    let out = gh(runner, cwd, args).map_err(|e| format!("gh could not tell: {e}"))?;
    serde_json::from_str(&out).map_err(|e| format!("gh could not tell: it printed no JSON: {e}"))
}

/// The head branch of `pr`, and where it came from (`how`).
fn named(pr: &Value, how: &str) -> Result<(String, String), String> {
    let n = number(pr);
    let name = pr
        .get("headRefName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("gh named no head branch for PR #{n}"))?;
    let from = format!("chain branch `{name}` from PR #{n} ({how})");
    Ok((name.to_owned(), from))
}

fn number(pr: &Value) -> u64 {
    pr.get("number").and_then(Value::as_u64).unwrap_or(0)
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
