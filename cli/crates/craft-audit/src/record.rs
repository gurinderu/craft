//! The run record an audit files, one per finished pass, named `audit` among the store's workflow
//! records: its verdict, its findings' severity mix after verification, what it read and what it
//! did not, and what did not run.

use serde_json::{Map, Value, json};

use crate::report::Summary;
use crate::state::AuditState;

/// The name the store files an audit's record under.
pub const NAME: &str = "audit";

/// The severities a record counts, worst first.
const SEVERITIES: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];

/// The settled findings' total and severity mix, refuted ones aside.
fn findings(sum: &Summary) -> Value {
    let standing: Vec<&Value> = sum
        .settled
        .iter()
        .filter(|f| f.get("tier").and_then(Value::as_str) != Some("refuted"))
        .collect();
    let mut by = Map::new();
    for s in SEVERITIES {
        let n = standing
            .iter()
            .filter(|f| f.get("severity").and_then(Value::as_str) == Some(s))
            .count();
        by.insert(s.to_owned(), json!(n));
    }
    json!({"total": standing.len(), "bySeverity": by})
}

/// What did not run: the files left unread, the findings at Medium and above left unjudged.
fn not_run(sum: &Summary) -> Vec<String> {
    let mut out = Vec::new();
    if !sum.unread.is_empty() {
        out.push(format!("audit:unread-files:{}", sum.unread.len()));
    }
    if sum.unjudged() > 0 {
        out.push(format!("audit:unjudged-findings:{}", sum.unjudged()));
    }
    out
}

/// The record of the audit `s` as `sum` says it.
#[must_use]
pub fn run_record(s: &AuditState, sum: &Summary) -> Value {
    let [confirmed, suspected, refuted, unverified] = sum.tiers();
    let batches: usize = s.scout.parts.iter().map(|p| p.batches.len()).sum();
    json!({
        "schemaVersion": 1,
        "runtime": "claude-code",
        "craftVersion": s.args.craft_version,
        "kind": "workflow",
        "name": NAME,
        "verdict": sum.verdict,
        "findings": findings(sum),
        "nested": false,
        "via": null,
        "audit": {
            "pass": s.pass,
            "paths": s.args.paths,
            "tracked": s.scout.tracked,
            "audited": s.scout.audited(),
            "outside": s.scout.outside.len(),
            "unread": sum.unread.len(),
            "batches": batches,
            "jobs": sum.jobs,
            "answered": sum.answered,
            "tiers": {"confirmed": confirmed, "suspected": suspected, "refuted": refuted, "unverified": unverified},
            "heldUnverified": sum.held().len(),
        },
        "notRun": not_run(sum),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::run_record;
    use crate::report::Summary;
    use crate::state::{Args, AuditState, Phase, STATE_VERSION};

    #[test]
    fn the_record_names_the_audit_its_verdict_what_it_left_unread_and_unjudged() {
        let s = AuditState {
            version: STATE_VERSION,
            cwd: "/r".into(),
            args: Args {
                craft_version: "9.9.9".into(),
                ..Args::default()
            },
            scout: crate::scout::Scouted::default(),
            phase: Phase::Done,
            pass: 2,
            tasks: Vec::new(),
            degraded: Vec::new(),
            notes: Vec::new(),
            stopped: None,
        };
        let sum = Summary {
            verdict: "Block (INCOMPLETE)".into(),
            unread: vec!["a.rs".into()],
            jobs: 4,
            answered: 3,
            settled: vec![
                json!({"severity": "High", "tier": "confirmed"}),
                json!({"severity": "Medium", "tier": "unverified"}),
                json!({"severity": "High", "tier": "refuted"}),
            ],
            left: Vec::new(),
        };
        let r = run_record(&s, &sum);
        assert_eq!(
            (r["kind"].clone(), r["name"].clone()),
            (json!("workflow"), json!("audit"))
        );
        assert_eq!(r["verdict"], "Block (INCOMPLETE)");
        assert_eq!(r["craftVersion"], "9.9.9");
        assert_eq!(r["findings"]["total"], 2);
        assert_eq!(r["findings"]["bySeverity"]["High"], 1);
        assert_eq!(r["audit"]["pass"], 2);
        assert_eq!(r["audit"]["tiers"]["refuted"], 1);
        assert_eq!(
            r["notRun"],
            json!(["audit:unread-files:1", "audit:unjudged-findings:1"])
        );
    }
}
