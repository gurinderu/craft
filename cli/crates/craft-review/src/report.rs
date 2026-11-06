//! What a finished run says: each finding's tier from its verdict, the run's verdict, and the
//! Markdown report.

use serde_json::Value;

use crate::prompts::LENS;
use crate::state::RunState;

/// Where a finding stands after verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// The verifier found the claim at the cited line and its premise held.
    Confirmed,
    /// The claim stands at the line but its off-site premise was not shown.
    Suspected,
    Refuted,
    /// No verdict came back.
    Unverified,
}

/// The tier a verdict gives its finding, as `votePanel` in `lib/review-verify.mjs` decides it
/// for a panel of one.
#[must_use]
pub fn tier(vote: Option<&Value>) -> Tier {
    let Some(v) = vote else {
        return Tier::Unverified;
    };
    let says = |k: &str| v.get(k).and_then(Value::as_bool);
    match (
        says("refuted"),
        says("citedLineMatches"),
        says("premiseSupported"),
    ) {
        (Some(false), Some(true), Some(true)) => Tier::Confirmed,
        (Some(false), Some(true), Some(false)) => Tier::Suspected,
        (Some(_), Some(_), Some(_)) => Tier::Refuted,
        _ => Tier::Unverified,
    }
}

/// A finding's severity, one notch lower when the verifier found its path unreachable in
/// production, as `DEMOTE` in `lib/review-verify.mjs`.
#[must_use]
pub fn severity(finding: &Value, vote: Option<&Value>) -> String {
    let s = finding
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("Info");
    let unreachable = vote
        .and_then(|v| v.get("reachable"))
        .and_then(Value::as_bool)
        == Some(false);
    if !unreachable {
        return s.to_owned();
    }
    match s {
        "Critical" => "High",
        "High" => "Medium",
        "Medium" => "Low",
        _ => "Info",
    }
    .to_owned()
}

/// How many findings are confirmed, suspected, refuted and unverified, in that order.
#[must_use]
pub fn tier_counts(state: &RunState) -> [usize; 4] {
    let mut n = [0_usize; 4];
    for i in 0..state.findings.len() {
        let slot = match tier(state.votes.get(i).and_then(Option::as_ref)) {
            Tier::Confirmed => 0,
            Tier::Suspected => 1,
            Tier::Refuted => 2,
            Tier::Unverified => 3,
        };
        if let Some(c) = n.get_mut(slot) {
            *c += 1;
        }
    }
    n
}

fn gating(severity: &str) -> bool {
    matches!(severity, "Critical" | "High" | "Medium")
}

/// The run's verdict: INCOMPLETE when the lens failed or a gating finding went unverified, else
/// Block on a confirmed Critical or High, Warning on a confirmed Medium, Approve otherwise.
#[must_use]
pub fn verdict(state: &RunState, lens_failed: bool) -> &'static str {
    let mut worst = "Approve";
    for (i, f) in state.findings.iter().enumerate() {
        let vote = state.votes.get(i).and_then(Option::as_ref);
        let sev = severity(f, vote);
        match tier(vote) {
            Tier::Unverified if gating(&sev) => return "INCOMPLETE",
            Tier::Confirmed if sev == "Critical" || sev == "High" => worst = "Block",
            Tier::Confirmed if sev == "Medium" && worst == "Approve" => worst = "Warning",
            Tier::Confirmed | Tier::Suspected | Tier::Refuted | Tier::Unverified => {}
        }
    }
    if lens_failed { "INCOMPLETE" } else { worst }
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The Markdown report of a finished run.
#[must_use]
pub fn markdown(state: &RunState, verdict: &str) -> String {
    let d = &state.diff;
    let mut out = format!("# craft review: {verdict}\n\n");
    let short = d.merge_base.get(..12).unwrap_or(&d.merge_base);
    out.push_str(&format!(
        "Base `{}` (merge-base `{short}`), {} changed file(s), {} Rust; lens: Rust {LENS}.\n\n",
        d.base,
        d.files.len(),
        state.rust_files.len()
    ));
    let mut confirmed = String::new();
    for (i, f) in state.findings.iter().enumerate() {
        let vote = state.votes.get(i).and_then(Option::as_ref);
        let t = tier(vote);
        if t == Tier::Confirmed {
            let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
            confirmed.push_str(&format!(
                "- **{}** `{}:{line}` — {}\n  - Why: {}\n  - Verifier: {}\n",
                severity(f, vote),
                field(f, "file"),
                field(f, "title"),
                field(f, "why").replace('\n', " "),
                vote.map_or("", |v| field(v, "reason")).replace('\n', " "),
            ));
        }
    }
    out.push_str("## Confirmed findings\n\n");
    out.push_str(if confirmed.is_empty() {
        "None.\n"
    } else {
        &confirmed
    });
    let [c, s, r, u] = tier_counts(state);
    out.push_str(&format!(
        "\n{} finding(s) reported: {c} confirmed, {s} suspected, {r} refuted, {u} unverified.\n",
        state.findings.len()
    ));
    if !state.notes.is_empty() {
        out.push_str("\n## Notes\n\n");
        for n in &state.notes {
            out.push_str(&format!("- {n}\n"));
        }
    }
    out
}
