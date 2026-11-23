//! The plan as its reader gets it, as `bannered` in `triage-findings.js`.
//!
//! It is led by a recall that may not have read the store, by what did not run, and by a write
//! that did not land; then come where the sift's records came from, what of them did not apply,
//! and the issues to file. The plan is the agent's object as it came, each field the engine sets
//! set in place or appended in the engine's order.

use crate::TriageError;
use crate::json::{Json, Obj};

/// The plan agent's answer (`content/schemas/triage-plan.schema.json`) and what the triage sets.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan(pub Obj);

impl Plan {
    /// The plan agent's answer read.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it is no object, or lacks a text `plan_markdown` or `summary`
    /// or a `ledger` (which, as in the engine, may be no list: the ledger then comes from the
    /// verdicts).
    pub fn read(answer: &Json) -> Result<Self, TriageError> {
        let refused = |why: &str| TriageError::Answer {
            what: "the plan agent's answer".into(),
            why: why.to_owned(),
        };
        let o = answer.as_object().ok_or_else(|| refused("no object"))?;
        for k in ["plan_markdown", "summary"] {
            if o.get(k).and_then(Json::as_str).is_none() {
                return Err(refused(&format!("no text {k}")));
            }
        }
        if o.get("ledger").is_none() {
            return Err(refused("no ledger"));
        }
        Ok(Self(o.clone()))
    }

    /// The ledger's rows, when it is a list.
    #[must_use]
    pub fn rows(&self) -> Option<&[Json]> {
        self.0.get("ledger").and_then(Json::as_array)
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
    pub issues: Vec<Json>,
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

/// The plan's markdown with `head` before it.
fn led(o: &mut Obj, head: &str) {
    let md = format!("{head}{}", o.text("plan_markdown"));
    o.set("plan_markdown", md);
}

/// `plan` as its reader gets it.
#[must_use]
pub fn bannered(plan: Plan, b: &Banners) -> Plan {
    let mut o = plan.0;
    if !b.memory_degraded.is_empty() {
        o.set("memoryDegraded", b.memory_degraded.clone());
        let head = "> **MEMORY DEGRADED** — the sift may have run without some or all of the project's records:";
        led(&mut o, &format!("{}\n", quoted(head, &b.memory_degraded)));
    }
    let missing = incomplete(&b.not_run_sources, b.unjudged);
    if !missing.is_empty() {
        let head =
            "> **INCOMPLETE TRIAGE** — this plan does not cover everything that was asked for:";
        led(&mut o, &format!("{}\n", quoted(head, &missing)));
        let summary = format!(
            "INCOMPLETE: {}\n\n{}",
            missing.join("; "),
            o.text("summary")
        );
        o.set("summary", summary);
        o.set("notRun", missing);
    }
    if !b.lost_section.is_empty() {
        led(&mut o, &b.lost_section);
        o.set("telemetryLost", b.telemetry_lost.clone());
    }
    o.set("memory", b.memory.as_str());
    for (k, v) in [
        ("priorDecisionsNotApplied", &b.prior_refused),
        ("ruleNotices", &b.rule_notices),
    ] {
        if !v.is_empty() {
            o.set(k, v.clone());
        }
    }
    if !b.issues.is_empty() {
        o.set("issues", b.issues.clone());
    }
    Plan(o)
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
