//! What a finished run says: each finding's tier from its verdict, the run's verdict, and the
//! Markdown report.

use serde_json::Value;

use crate::prompts::LENS;
use crate::state::RunState;

pub use crate::settle::Tier;
use crate::settle::{settle, tier};

/// Each finding as its verdict settled it: its tier and its final severity, capped by its harm.
fn settled(state: &RunState) -> impl Iterator<Item = (Tier, Value)> + '_ {
    state
        .findings
        .iter()
        .enumerate()
        .map(|(i, f)| settle(f, state.votes.get(i).and_then(Option::as_ref)))
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
    for (t, f) in settled(state) {
        let sev = field(&f, "severity");
        match t {
            Tier::Unverified if gating(sev) => return "INCOMPLETE",
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
    let short = |sha: &str| sha.get(..12).unwrap_or(sha).to_owned();
    let tree = if d.dirty {
        ", with uncommitted changes"
    } else {
        ", clean tree"
    };
    out.push_str(&format!(
        "Head `{}`{tree}; base `{}` (merge-base `{}`), {} changed file(s), {} Rust; lens: Rust {LENS}.\n\n",
        d.head,
        d.base,
        short(&d.merge_base),
        d.files.len(),
        state.rust_files.len()
    ));
    let mut confirmed = String::new();
    for (i, (t, f)) in settled(state).enumerate() {
        let vote = state.votes.get(i).and_then(Option::as_ref);
        if t == Tier::Confirmed {
            let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
            confirmed.push_str(&format!(
                "- **{}** `{}:{line}` — {}\n  - Why: {}\n  - Verifier: {}\n",
                field(&f, "severity"),
                field(&f, "file"),
                field(&f, "title"),
                field(&f, "why").replace('\n', " "),
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
