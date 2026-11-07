//! What a finished run says: each finding's tier from its verdict, the run's verdict, and the
//! Markdown report.

use serde_json::Value;

use crate::state::RunState;

pub use crate::settle::Tier;
use crate::settle::{settle, tier};

/// Each finding as its verdict settled it, with that verdict: its tier and its final severity,
/// capped by its harm.
fn settled(state: &RunState) -> impl Iterator<Item = (Tier, Value, Option<&Value>)> + '_ {
    state.findings.iter().enumerate().map(|(i, f)| {
        let vote = state.votes.get(i).and_then(Option::as_ref);
        let (t, f) = settle(f, vote);
        (t, f, vote)
    })
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

/// The run's verdict: INCOMPLETE when a gating finding went unverified; else Block on a confirmed
/// Critical or High, Warning on a confirmed Medium, Approve otherwise — and, when something the
/// review needed did not run (`not_run`), INCOMPLETE in place of Approve and a red verdict marked
/// ` (INCOMPLETE)`, as `honestVerdict`.
#[must_use]
pub fn verdict(state: &RunState) -> String {
    let mut worst = "Approve";
    for (t, f, _) in settled(state) {
        let sev = field(&f, "severity");
        match t {
            Tier::Unverified if gating(sev) => return "INCOMPLETE".into(),
            Tier::Confirmed if sev == "Critical" || sev == "High" => worst = "Block",
            Tier::Confirmed if sev == "Medium" && worst == "Approve" => worst = "Warning",
            Tier::Confirmed | Tier::Suspected | Tier::Refuted | Tier::Unverified => {}
        }
    }
    match (state.not_run.is_empty(), worst) {
        (true, w) => w.into(),
        (false, "Approve") => "INCOMPLETE".into(),
        (false, w) => format!("{w} (INCOMPLETE)"),
    }
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn one_line(s: &str) -> String {
    s.replace('\n', " ")
}

/// One finding as a report entry.
fn entry(f: &Value, vote: Option<&Value>) -> String {
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let by = match f.get("sources").and_then(Value::as_array) {
        Some(s) => s
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        None => field(f, "source").to_owned(),
    };
    let mut e = format!(
        "- **{}** `{}:{line}` — {} ({by})\n  - Why: {}\n",
        field(f, "severity"),
        field(f, "file"),
        field(f, "title"),
        one_line(field(f, "why")),
    );
    if let Some(v) = vote.map(|v| field(v, "reason")).filter(|r| !r.is_empty()) {
        e.push_str(&format!("  - Verifier: {}\n", one_line(v)));
    }
    e
}

/// The header lines: what was reviewed, the plan and the lens rounds.
fn header(state: &RunState) -> String {
    let d = &state.diff;
    let short = |sha: &str| sha.get(..12).unwrap_or(sha).to_owned();
    let tree = if d.dirty {
        ", with uncommitted changes"
    } else {
        ", clean tree"
    };
    let mut out = format!(
        "Head `{}`{tree}; base `{}` (merge-base `{}`), {} changed file(s), {} Rust.\n\n",
        d.head,
        d.base,
        short(&d.merge_base),
        d.files.len(),
        state.rust_files.len()
    );
    let Some(plan) = &state.plan else {
        return out;
    };
    let depth = if state.light {
        "light pass"
    } else {
        "full review"
    };
    let ran = state.rounds.ran(plan);
    out.push_str(&format!(
        "Plan: {} diff, {depth}, at most {} round(s). Lenses planned: {}; ran: {}.\n",
        plan.size_bucket,
        plan.max_rounds,
        plan.lenses.join(", "),
        if ran.is_empty() {
            "none".into()
        } else {
            ran.join(", ")
        },
    ));
    if !plan.surface_dropped.is_empty() {
        out.push_str(&format!(
            "Dropped by the scout's surfaces: {}.\n",
            plan.surface_dropped.join(", ")
        ));
    }
    if !plan.light_skipped.is_empty() {
        out.push_str(&format!(
            "Light pass: whole-diff lenses NOT dispatched: {}; one round; Low and Info not verified.\n",
            plan.light_skipped.join(", ")
        ));
    }
    for y in &state.rounds.yields {
        out.push_str(&format!(
            "- Round {}: {} lens(es) dispatched, {} returned, {} new finding(s).\n",
            y.round, y.agents, y.returned, y.new_findings
        ));
    }
    out.push('\n');
    out
}

/// The Markdown report of a finished run: the findings grouped by tier, worst first in each.
#[must_use]
pub fn markdown(state: &RunState, verdict: &str) -> String {
    let mut out = format!("# craft review: {verdict}\n\n{}", header(state));
    let tiers = [
        (Tier::Confirmed, "Confirmed"),
        (Tier::Suspected, "Suspected"),
        (Tier::Unverified, "Unverified"),
        (Tier::Refuted, "Refuted"),
    ];
    for (want, name) in tiers {
        let mut list: Vec<(usize, String)> = settled(state)
            .filter(|(t, _, _)| *t == want)
            .map(|(_, f, v)| (crate::dedup::sev_rank(&f), entry(&f, v)))
            .collect();
        list.sort_by_key(|(rank, _)| *rank);
        out.push_str(&format!("## {name} findings\n\n"));
        if list.is_empty() {
            out.push_str("None.\n");
        }
        for (_, e) in list {
            out.push_str(&e);
        }
        out.push('\n');
    }
    let [c, s, r, u] = tier_counts(state);
    out.push_str(&format!(
        "{} finding(s) reported: {c} confirmed, {s} suspected, {r} refuted, {u} unverified.\n",
        state.findings.len()
    ));
    for (title, list) in [("Not run", &state.not_run), ("Notes", &state.notes)] {
        if !list.is_empty() {
            out.push_str(&format!("\n## {title}\n\n"));
            for n in list {
                out.push_str(&format!("- {n}\n"));
            }
        }
    }
    out
}
