//! The finished step: where the report is and the verdict, and what the host files as the run's
//! record beside them — the verdict line as the report shows it, the head and base the run read,
//! the findings it reported (severity, file, line, title, tier), the changed files no profile
//! covered and what did not run, the sorting before publication, the findings going against
//! memory and what was posted on the PR ([`crate::publish`]), and what the lenses yielded and
//! verification judged ([`crate::telemetry`]). Refuted findings are left out of `findings`: the
//! run did not report them.

use std::path::Path;

use serde_json::{Value, json};

use crate::prompts::ReScope;
use crate::report::{self, Tier};
use crate::state::{self, RunState};
use crate::telemetry;

/// The finished step of the run in `dir`, whose verdict is `verdict`.
pub(crate) fn step(dir: &Path, run: &RunState, verdict: &str) -> Value {
    let mut done = json!({
        "run": dir.display().to_string(), "done": true,
        "report": state::report_path(dir).display().to_string(),
        "verdict": verdict, "line": report::verdict_line(run, verdict),
        "head": run.diff.head, "base": base(run), "repo": run.context.repo,
        "findings": findings(run), "uncovered": run.uncovered, "notRun": run.not_run,
        "lensScope": if run.context.re_review == ReScope::Fixes { "delta" } else { "full" },
        "round": run.chain.round.max(1), "ledger": run.chain.ledger, "reReview": re_review(run),
        "memory": run.memory.source.record(), "strict": run.context.strict,
        "memorySections": report::memory_sections(run),
        "dimensions": telemetry::dimensions(run), "verification": telemetry::verification(run),
        "lensRounds": run.rounds.yields,
    });
    if let Some(obj) = done.as_object_mut() {
        if !run.degraded.is_empty() {
            obj.insert("degraded".into(), json!(run.degraded));
        }
        for (k, v) in crate::publish::finished(run) {
            obj.insert(k.into(), v);
        }
    }
    name_worktree(&mut done, run);
    done
}

/// `step` naming craft's own worktree the run reviews in, when it does (`worktree`).
pub(crate) fn name_worktree(step: &mut Value, run: &RunState) {
    if let (Some(obj), Some(line)) = (step.as_object_mut(), &run.chain.worktree) {
        obj.insert("worktree".into(), json!(line));
    }
}

/// The base the branch is reviewed against: the chain's, which a re-review of the fix commits
/// keeps although its diff starts at the prior round's head.
pub(crate) fn base(run: &RunState) -> &str {
    if run.chain.base.is_empty() {
        &run.diff.base
    } else {
        &run.chain.base
    }
}

/// What the record keeps of the round: whether it built on a prior round, which, what its lenses
/// reviewed, and how the prior findings fared.
fn re_review(run: &RunState) -> Value {
    let c = &run.chain;
    let [
        resolved,
        still_open,
        regressed,
        carried,
        unverified,
        retired,
    ] = c.tally();
    json!({
        "chained": c.prior.is_some(), "reason": c.unchained,
        "priorRun": c.prior.as_ref().map(|p| &p.dir), "priorRound": c.prior.as_ref().map(|p| p.round),
        "priorHead": c.prior.as_ref().map(|p| &p.head), "scope": run.context.re_review, "rescan": c.rescan,
        "resolved": resolved, "stillOpen": still_open, "regressed": regressed, "carried": carried,
        "unverified": unverified, "retired": retired, "absorbed": c.absorbed, "regressions": c.regressions,
    })
}

/// The reported findings, each as the record's ledger keys it.
fn findings(run: &RunState) -> Vec<Value> {
    let text = |f: &Value, k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    run.settled
        .iter()
        .filter(|f| Tier::of(f) != Tier::Refuted)
        .map(|f| {
            json!({
                "severity": text(f, "severity"), "file": text(f, "file"),
                "line": f.get("line").and_then(Value::as_i64).unwrap_or(0),
                "title": text(f, "title"), "ruleId": text(f, "ruleId"), "tier": Tier::of(f).name(),
            })
        })
        .collect()
}
