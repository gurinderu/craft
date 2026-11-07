//! What a finished run says: the run's verdict from its settled findings, and the Markdown report.

use serde_json::Value;

use crate::state::RunState;

mod light;

pub use crate::settle::Tier;

/// How many findings are confirmed, suspected, refuted and unverified, in that order.
#[must_use]
pub fn tier_counts(state: &RunState) -> [usize; 4] {
    let mut n = [0_usize; 4];
    for f in &state.settled {
        let slot = match Tier::of(f) {
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

/// The run's verdict: a coverage exit's own; else Block on a confirmed Critical or High, Warning on
/// a confirmed Medium, Approve otherwise — and, when something the review needed did not run
/// (`not_run`, where every finding verification failed to judge is named), INCOMPLETE in place of
/// Approve and a red verdict marked ` (INCOMPLETE)`, as `honestVerdict`.
#[must_use]
pub fn verdict(state: &RunState) -> String {
    if let Some(exit) = &state.exit {
        return exit.verdict.clone();
    }
    let mut worst = "Approve";
    for f in state
        .settled
        .iter()
        .filter(|f| Tier::of(f) == Tier::Confirmed)
    {
        match field(f, "severity") {
            "Critical" | "High" => worst = "Block",
            "Medium" if worst == "Approve" => worst = "Warning",
            _ => {}
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
fn entry(f: &Value) -> String {
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
    if let Some(v) = Some(field(f, "verifierReason")).filter(|r| !r.is_empty()) {
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
    for y in &state.rounds.yields {
        out.push_str(&format!(
            "- Round {}: {} lens(es) dispatched, {} returned, {} new finding(s).\n",
            y.round, y.agents, y.returned, y.new_findings
        ));
    }
    out.push('\n');
    out
}

/// The Markdown report of a finished run: the verdict, then the findings grouped by tier, worst
/// first in each.
#[must_use]
pub fn markdown(state: &RunState, verdict: &str) -> String {
    let line = state.exit.as_ref().map_or(verdict, |e| e.line.as_str());
    let line = if state.light {
        light::mark(line)
    } else {
        line.to_owned()
    };
    let mut out = format!(
        "# craft review\n\n## Verdict\n\n{line}\n\n{}",
        header(state)
    );
    if let Some(listed) = state.exit.as_ref().and_then(|e| e.listed.as_ref()) {
        out.push_str(&format!("## {listed}\n\n"));
        for f in &state.diff.files {
            out.push_str(&format!("- {f}\n"));
        }
        out.push('\n');
    }
    if state.exit.is_none() {
        findings(state, &mut out);
    }
    out.push_str("\n## Not run\n\n");
    for n in &state.not_run {
        out.push_str(&format!("- {n}\n"));
    }
    out.push_str(&format!("- {}\n", light::cli_not_run()));
    if !state.notes.is_empty() {
        out.push_str("\n## Notes\n\n");
        for n in &state.notes {
            out.push_str(&format!("- {n}\n"));
        }
    }
    if state.light {
        out.push_str(&light::section(state));
    }
    out
}

/// The findings by tier and their count.
fn findings(state: &RunState, out: &mut String) {
    let tiers = [
        (Tier::Confirmed, "Confirmed"),
        (Tier::Suspected, "Suspected"),
        (Tier::Unverified, "Unverified"),
        (Tier::Refuted, "Refuted"),
    ];
    for (want, name) in tiers {
        let mut list: Vec<(usize, String)> = state
            .settled
            .iter()
            .filter(|f| Tier::of(f) == want)
            .map(|f| (crate::dedup::sev_rank(f), entry(f)))
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
        state.settled.len()
    ));
}
