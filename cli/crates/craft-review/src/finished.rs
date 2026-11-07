//! The finished step: where the report is and the verdict, and what the host files as the run's
//! record beside them — the verdict line as the report shows it, the head and base the run read,
//! the findings it reported (severity, file, line, title, tier), the changed files no profile
//! covered and what did not run. Refuted findings are left out: the run did not report them.

use std::path::Path;

use serde_json::{Value, json};

use crate::report::{self, Tier};
use crate::state::{self, RunState};

/// The finished step of the run in `dir`, whose verdict is `verdict`.
pub(crate) fn step(dir: &Path, run: &RunState, verdict: &str) -> Value {
    let mut done = json!({
        "run": dir.display().to_string(), "done": true,
        "report": state::report_path(dir).display().to_string(),
        "verdict": verdict, "line": report::verdict_line(run, verdict),
        "head": run.diff.head, "base": run.diff.base,
        "findings": findings(run), "uncovered": run.uncovered, "notRun": run.not_run,
    });
    if let (Some(obj), false) = (done.as_object_mut(), run.degraded.is_empty()) {
        obj.insert("degraded".into(), json!(run.degraded));
    }
    done
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
