//! What GitHub says of a commit's CI, as the gate reads it (realm @nick/craft, node #482): its
//! check runs and its commit statuses, through `gh api` on the gate's runner, the repository
//! named by gh's own `{owner}/{repo}` from the working tree's remote, as publishing names it.
//! Each check's latest run counts (a re-run replaces the run before it); a run that has not
//! completed, or ended neither green nor red, gives no signal.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::runner::Runner;
use crate::gh::gh;

/// How one check or status came out for the commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Light {
    Green,
    Red,
    /// No signal: not completed, or a conclusion neither green nor red (`cancelled`, `skipped`…).
    None(String),
}

/// One check's name as GitHub reports it, and how it came out.
pub(super) type Seen = Vec<(String, Light)>;

/// The check runs and statuses of `sha` in the repository at `top`.
///
/// # Errors
/// Why GitHub was not read: no gh, no auth, no network, an answer that is not JSON.
pub(super) fn seen(runner: &Runner, top: &Path, sha: &str) -> Result<Seen, String> {
    let at = format!("repos/{{owner}}/{{repo}}/commits/{sha}");
    let runs = json(&gh(
        runner,
        top,
        &["api", &format!("{at}/check-runs?per_page=100")],
    )?)?;
    let status = json(&gh(
        runner,
        top,
        &["api", &format!("{at}/status?per_page=100")],
    )?)?;
    let mut out = check_runs(&runs);
    out.extend(statuses(&status));
    Ok(out)
}

fn json(out: &str) -> Result<Value, String> {
    serde_json::from_str(out).map_err(|e| format!("gh api printed no JSON: {e}"))
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Each check run's latest run (the highest id) by name, and how it came out.
fn check_runs(v: &Value) -> Seen {
    let mut latest: BTreeMap<&str, (u64, &Value)> = BTreeMap::new();
    let runs = v.get("check_runs").and_then(Value::as_array);
    for r in runs.into_iter().flatten() {
        let id = r.get("id").and_then(Value::as_u64).unwrap_or(0);
        let name = text(r, "name");
        if latest.get(name).is_none_or(|(at, _)| id > *at) {
            latest.insert(name, (id, r));
        }
    }
    latest
        .into_iter()
        .map(|(name, (_, r))| {
            let light = match (text(r, "status"), text(r, "conclusion")) {
                ("completed", "success") => Light::Green,
                ("completed", "failure") => Light::Red,
                ("completed", other) => Light::None(other.to_owned()),
                (status, _) => Light::None(status.to_owned()),
            };
            (name.to_owned(), light)
        })
        .collect()
}

/// Each commit status by context (the combined status holds the latest of each), and how it came
/// out.
fn statuses(v: &Value) -> Seen {
    let list = v.get("statuses").and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .map(|s| {
            let light = match text(s, "state") {
                "success" => Light::Green,
                "failure" => Light::Red,
                other => Light::None(other.to_owned()),
            };
            (text(s, "context").to_owned(), light)
        })
        .collect()
}
