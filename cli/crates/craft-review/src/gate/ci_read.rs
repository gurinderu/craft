//! What GitHub says of a commit's CI, as the gate reads it (realm @nick/craft, node #482): its
//! check runs and its commit statuses, through `gh api` on the gate's runner, the repository
//! named by gh's own `{owner}/{repo}` from the working tree's remote, as publishing names it.
//! Within one check suite a check's latest run counts (a re-run supersedes the run before it);
//! runs of one name in different suites (another workflow, app or event) each count, so a red in
//! one is never dropped by a green in another. A run that has not completed, or ended neither
//! green nor red, gives no signal. An answer holding more than the one page read gives no signal
//! at all: the gate never decides on a partial set.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::runner::Runner;
use crate::gh::gh;

/// How many runs or statuses one page holds, the only page read.
const PAGE: usize = 100;

/// How one check or status came out for the commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Light {
    Green,
    Red,
    /// No signal: not completed, or a conclusion neither green nor red (`cancelled`, `skipped`,
    /// `timed_out`, `startup_failure`, `action_required`…).
    None(String),
}

/// One check's name as GitHub reports it, and how it came out.
pub(super) type Seen = Vec<(String, Light)>;

/// The check runs and statuses of `sha` in the repository at `top`.
///
/// # Errors
/// Why GitHub was not read: no gh, no auth, no network, an answer that is not JSON, or one holding
/// more than the page read.
pub(super) fn seen(runner: &Runner, top: &Path, sha: &str) -> Result<Seen, String> {
    let at = format!("repos/{{owner}}/{{repo}}/commits/{sha}");
    let read = |what: &str| {
        let out = gh(
            runner,
            top,
            &["api", &format!("{at}/{what}?per_page={PAGE}")],
        )?;
        json(&out)
    };
    let runs = read("check-runs")?;
    whole(&runs, "check_runs", "check runs")?;
    let status = read("status")?;
    whole(&status, "statuses", "commit statuses")?;
    let mut out = check_runs(&runs);
    out.extend(statuses(&status));
    Ok(out)
}

/// Refuses an answer whose `total_count` is not the number of `key` items it holds: more than the
/// one page read, or a count it does not state.
fn whole(v: &Value, key: &str, what: &str) -> Result<(), String> {
    let held = v.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    match v.get("total_count").and_then(Value::as_u64) {
        Some(n) if usize::try_from(n).is_ok_and(|n| n == held) => Ok(()),
        Some(n) => Err(format!(
            "GitHub holds {n} {what} for the head, more than the one page of {PAGE} read: no signal from a partial set"
        )),
        None => Err(format!("GitHub's answer states no count of its {what}")),
    }
}

fn json(out: &str) -> Result<Value, String> {
    serde_json::from_str(out).map_err(|e| format!("gh api printed no JSON: {e}"))
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A run's check suite: the one it names, or the run alone when it names none, so runs of unknown
/// suites never supersede one another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Suite {
    Named(u64),
    Alone(u64),
}

fn suite(r: &Value, id: u64) -> Suite {
    let named = r
        .get("check_suite")
        .and_then(|s| s.get("id"))
        .and_then(Value::as_u64);
    named.map_or(Suite::Alone(id), Suite::Named)
}

/// A check's name and its suite.
type Key<'a> = (&'a str, Suite);

/// Each check's latest run (the highest id) in each check suite, by name, and how it came out.
fn check_runs(v: &Value) -> Seen {
    let mut latest: BTreeMap<Key<'_>, (u64, &Value)> = BTreeMap::new();
    let runs = v.get("check_runs").and_then(Value::as_array);
    for r in runs.into_iter().flatten() {
        let id = r.get("id").and_then(Value::as_u64).unwrap_or(0);
        let key = (text(r, "name"), suite(r, id));
        if latest.get(&key).is_none_or(|(at, _)| id > *at) {
            latest.insert(key, (id, r));
        }
    }
    latest
        .into_iter()
        .map(|((name, _), (_, r))| {
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
/// out: `failure` and `error` are red, `pending` gives no signal.
fn statuses(v: &Value) -> Seen {
    let list = v.get("statuses").and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .map(|s| {
            let light = match text(s, "state") {
                "success" => Light::Green,
                "failure" | "error" => Light::Red,
                other => Light::None(other.to_owned()),
            };
            (text(s, "context").to_owned(), light)
        })
        .collect()
}
