//! A pull request's review threads, read with `gh`: which PR (the number given, else the checked-out
//! branch's), which repository (the one given, else the checkout's), and every page of its
//! `reviewThreads` through `gh api graphql --paginate --slurp` — the fields the thread rules read,
//! `authorAssociation`, `pullRequest.author` and `pullRequest.isCrossRepository` among them.

use std::path::Path;

use serde_json::Value;

use crate::gate::runner::Runner;
use crate::gh::gh;
use crate::publish::PostSetup;

/// The query: the PR's author, whether its head is a fork's, and, a hundred threads a page, each thread's path, lines and its
/// first fifty comments.
const QUERY: &str = "query($owner:String!, $name:String!, $pr:Int!, $endCursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      author { login }
      isCrossRepository
      reviewThreads(first:100, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        totalCount
        nodes {
          path
          line
          originalLine
          comments(first:50) {
            totalCount
            nodes { author { login } authorAssociation body url createdAt originalCommit { oid } }
          }
        }
      }
    }
  }
}";

/// Why the threads could not be read.
#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("{0}")]
    Gh(String),
    #[error("--repo must be <owner>/<name>, got {0:?}")]
    Repo(String),
}

/// Which pull request: its number, else the checked-out branch's; in which repository:
/// `<owner>/<name>`, else the checkout's.
pub struct Which<'a> {
    pub pr: Option<u64>,
    pub repo: Option<&'a str>,
}

fn json(out: &str, what: &str) -> Result<Value, FetchError> {
    serde_json::from_str(out).map_err(|e| FetchError::Gh(format!("{what} printed no JSON: {e}")))
}

/// The owner and name of the repository `which` names, else the checkout's.
fn owner_name(
    runner: &Runner,
    dir: &Path,
    which: &Which<'_>,
) -> Result<(String, String), FetchError> {
    if let Some(r) = which.repo {
        return match r.split_once('/') {
            Some((o, n))
                if !o.is_empty() && !n.is_empty() && !n.contains('/') && !r.starts_with('-') =>
            {
                Ok((o.to_owned(), n.to_owned()))
            }
            _ => Err(FetchError::Repo(r.to_owned())),
        };
    }
    let v = json(
        &gh(runner, dir, &["repo", "view", "--json", "owner,name"]).map_err(FetchError::Gh)?,
        "gh repo view",
    )?;
    let owner = v
        .get("owner")
        .and_then(|o| o.get("login"))
        .and_then(Value::as_str);
    match (owner, v.get("name").and_then(Value::as_str)) {
        (Some(o), Some(n)) => Ok((o.to_owned(), n.to_owned())),
        _ => Err(FetchError::Gh(
            "gh repo view named no owner and name".into(),
        )),
    }
}

/// The number of the pull request `which` names, else the checked-out branch's.
fn number(runner: &Runner, dir: &Path, which: &Which<'_>, repo: &str) -> Result<u64, FetchError> {
    if let Some(n) = which.pr {
        return Ok(n);
    }
    let out = gh(
        runner,
        dir,
        &["pr", "view", "--repo", repo, "--json", "number"],
    )
    .map_err(|e| {
        FetchError::Gh(format!(
            "{e} (no pull request for the checked-out branch, or gh is not authenticated)"
        ))
    })?;
    json(&out, "gh pr view")?
        .get("number")
        .and_then(Value::as_u64)
        .filter(|&n| n > 0)
        .ok_or_else(|| FetchError::Gh("gh pr view named no pull request number".into()))
}

/// Every page of the review threads of the pull request `which` names, run from `dir`, gh's
/// output kept in `scratch`.
///
/// # Errors
/// When `--repo` is malformed, or gh fails or prints no JSON.
pub fn answer(
    dir: &Path,
    which: &Which<'_>,
    setup: &PostSetup,
    scratch: &Path,
) -> Result<Value, FetchError> {
    let runner = Runner::new(setup.budget, setup.path.clone(), scratch.to_path_buf());
    let (owner, name) = owner_name(&runner, dir, which)?;
    let pr = number(&runner, dir, which, &format!("{owner}/{name}"))?;
    let (q, o, n, p) = (
        format!("query={QUERY}"),
        format!("owner={owner}"),
        format!("name={name}"),
        format!("pr={pr}"),
    );
    let args = [
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        &q,
        // Raw (`-f`): `-F` sends an all-digit name as a number and reads `@…` as a file.
        "-f",
        &o,
        "-f",
        &n,
        "-F",
        &p,
    ];
    json(
        &gh(&runner, dir, &args).map_err(FetchError::Gh)?,
        "gh api graphql",
    )
}
