//! The plan as its reader gets it, as `bannered` in `triage-findings.js`: led by a recall that may
//! not have read the store, by what did not run, and by a write that did not land; then where the
//! sift's records came from, what of them did not apply, and the issues to file.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TriageError;
use crate::issue::Issue;

/// The plan agent's answer (`content/schemas/triage-plan.schema.json`) and what the triage adds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(rename = "plan_markdown", default)]
    pub plan_markdown: String,
    /// The ledger as the agent gave it, set to the final one by the caller when it is a list.
    #[serde(default)]
    pub ledger: Value,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_degraded: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_run: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_lost: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_decisions_not_applied: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_notices: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<Issue>>,
}

impl Plan {
    /// The plan agent's answer read.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it is not the plan schema's shape.
    pub fn read(answer: &Value) -> Result<Self, TriageError> {
        serde_json::from_value(answer.clone())
            .map_err(|e| TriageError::answer("the plan agent's answer", &e))
    }
}

/// What leads and closes the plan, each computed by its owner.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Banners {
    /// The recall's degraded notes (`memoryDegradedNotes`).
    pub memory_degraded: Vec<String>,
    /// The requested sources that produced nothing.
    pub not_run_sources: Vec<String>,
    /// How many validators died.
    pub unjudged: usize,
    /// The lost-record section (`telemetryLostSection`) and the losses it counts.
    pub lost_section: String,
    pub telemetry_lost: Vec<String>,
    /// The memory line (`memoryLine`).
    pub memory: String,
    pub prior_refused: Vec<String>,
    pub rule_notices: Vec<String>,
    pub issues: Vec<Issue>,
}

/// A banner: its heading, a `> - ` line per note, an empty line.
fn quoted(head: &str, notes: &[String]) -> String {
    let mut lines = vec![head.to_owned()];
    lines.extend(notes.iter().map(|l| format!("> - {l}")));
    lines.push(String::new());
    lines.join("\n")
}

/// What did not run, as the plan's reader is told it.
#[must_use]
pub fn incomplete(not_run_sources: &[String], unjudged: usize) -> Vec<String> {
    let mut lines: Vec<String> = not_run_sources
        .iter()
        .map(|s| format!("source `{s}` produced nothing — its findings are NOT in this plan"))
        .collect();
    if unjudged > 0 {
        lines.push(format!("{unjudged} finding(s) were never judged against the code (validator died); they sit in the ledger as needs-decision, not in the plan"));
    }
    lines
}

/// `plan` as its reader gets it.
#[must_use]
pub fn bannered(mut plan: Plan, b: &Banners) -> Plan {
    if !b.memory_degraded.is_empty() {
        let head = "> **MEMORY DEGRADED** — the sift may have run without some or all of the project's records:";
        plan.plan_markdown = format!(
            "{}\n{}",
            quoted(head, &b.memory_degraded),
            plan.plan_markdown
        );
        plan.memory_degraded = Some(b.memory_degraded.clone());
    }
    let missing = incomplete(&b.not_run_sources, b.unjudged);
    if !missing.is_empty() {
        let head =
            "> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:";
        plan.plan_markdown = format!("{}\n{}", quoted(head, &missing), plan.plan_markdown);
        plan.summary = format!("INCOMPLETE: {}\n\n{}", missing.join("; "), plan.summary);
        plan.not_run = Some(missing);
    }
    if !b.lost_section.is_empty() {
        plan.plan_markdown = format!("{}{}", b.lost_section, plan.plan_markdown);
        plan.telemetry_lost = Some(b.telemetry_lost.clone());
    }
    plan.memory = Some(b.memory.clone());
    let some = |v: &Vec<String>| (!v.is_empty()).then(|| v.clone());
    plan.prior_decisions_not_applied = some(&b.prior_refused);
    plan.rule_notices = some(&b.rule_notices);
    plan.issues = (!b.issues.is_empty()).then(|| b.issues.clone());
    plan
}

/// What the triage returns when the plan agent returned nothing.
#[must_use]
pub fn failed(lost_section: &str) -> String {
    format!(
        "{lost_section}Triage failed: the Plan-phase agent returned no result. Re-run, or triage the findings manually."
    )
}

#[cfg(test)]
mod tests;
