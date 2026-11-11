//! What gh says of the pull request a detached `HEAD`'s chain is keyed on: the one given, or the one
//! open PR whose head is `HEAD`, and the chain branch it names.

use std::path::Path;

use serde_json::Value;

use crate::gate::runner::Runner;
use crate::gh::gh;

/// What a pull request names the chain: its branch, where that came from, its number, and its
/// head commit as gh names it (empty when gh named none).
pub(super) struct Named {
    pub(super) name: String,
    pub(super) from: String,
    pub(super) pr: u64,
    pub(super) head: String,
}

/// The fields gh is asked for a pull request.
const FIELDS: &str = "number,headRefName,headRefOid,isCrossRepository,headRepositoryOwner";

/// The head branch and head commit of pull request `n`, given (`pr`): the branch names a detached
/// `HEAD`'s chain whatever its head is now, as the ancestry check keeps a round of a rewritten
/// history out of it; the commit is what `HEAD` must be or hold ([`super::head`]).
pub(super) fn given(runner: &Runner, cwd: &Path, n: u64) -> Result<Named, String> {
    let v = ask(
        runner,
        cwd,
        &["pr", "view", &n.to_string(), "--json", FIELDS],
    )?;
    named(&v, &format!("pr={n}, detached HEAD"))
}

/// The head branch of the one open pull request whose head is `head`: a search by the commit also
/// finds a PR that only contains it, so a PR at another head is not taken, nor one of several.
pub(super) fn heading(runner: &Runner, cwd: &Path, head: &str) -> Result<Named, String> {
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

/// The chain branch `pr` names, and where it came from (`how`): its head branch, or for a PR from
/// a fork `<owner>:<head branch>` — a name no local branch can have, ':' being no part of a git
/// ref, so a fork's `main` never joins the rounds of the local `main` (realm @nick/craft, node #104).
fn named(pr: &Value, how: &str) -> Result<Named, String> {
    let n = number(pr);
    let head = pr
        .get("headRefName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("gh named no head branch for PR #{n}"))?;
    let name = if pr.get("isCrossRepository").and_then(Value::as_bool) == Some(true) {
        let owner = pr
            .pointer("/headRepositoryOwner/login")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("gh named no owner of the fork PR #{n} comes from"))?;
        format!("{owner}:{head}")
    } else {
        head.to_owned()
    };
    let from = format!("chain branch `{name}` from PR #{n} ({how})");
    let oid = pr
        .get("headRefOid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(Named {
        name,
        from,
        pr: n,
        head: oid,
    })
}

fn number(pr: &Value) -> u64 {
    pr.get("number").and_then(Value::as_u64).unwrap_or(0)
}
