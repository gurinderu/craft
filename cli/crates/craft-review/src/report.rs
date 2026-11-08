//! What a finished run says: the run's verdict from its settled findings, and the Markdown report.

use serde_json::Value;

use crate::coverage;
use crate::state::{RunState, Track};

mod light;
mod rereview;
#[cfg(test)]
mod tests;

use rereview::rereview_line;

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
/// Approve and a red verdict marked ` (INCOMPLETE)`, as `honestVerdict`; otherwise, when changed
/// files that carry code went unreviewed (`coverage::gap`), marked ` (PARTIAL COVERAGE)`, as
/// `verdictSuffix` in `lib/review-coverage.mjs`: a hole a re-run will not fill.
#[must_use]
pub fn verdict(state: &RunState) -> String {
    let worst = severity_verdict(state);
    if worst.contains("INCOMPLETE") || coverage::gap(&state.uncovered).is_empty() {
        return worst;
    }
    format!("{worst} (PARTIAL COVERAGE)")
}

/// The verdict line as the report and the finished step show it: a coverage exit's own line, else
/// the verdict with what a coverage gap left out; marked as a light pass's when it was one.
#[must_use]
pub fn verdict_line(state: &RunState, verdict: &str) -> String {
    let gap = coverage::gap(&state.uncovered);
    let line = match (&state.exit, gap.is_empty()) {
        (Some(exit), _) if exit.verdict == verdict => exit.line.clone(),
        (Some(_), _) => format!("{verdict} — {}", rereview_line(state)),
        (None, true) => verdict.to_owned(),
        (None, false) => format!(
            "{verdict} — {}: this verdict covers only the files its language profiles reviewed",
            coverage::note(&gap)
        ),
    };
    let line = if strict_escalates(state) {
        format!(
            "{line} · strict maintainability mode escalated it: a confirmed maintainability finding at Medium or above is a presumptive blocker"
        )
    } else {
        line
    };
    if state.light {
        light::mark(&line)
    } else {
        line
    }
}

/// The verdict from the severities of the confirmed findings and of the prior round's findings
/// still open (`rereviewVerdict`), and what did not run. A coverage exit's own verdict stands
/// unless a prior finding still holds the run.
fn severity_verdict(state: &RunState) -> String {
    let mut worst = "Approve";
    for f in &verdict_findings(state) {
        match field(f, "severity").to_lowercase().as_str() {
            "critical" | "high" => worst = "Block",
            "medium" if worst == "Approve" => worst = "Warning",
            _ => {}
        }
    }
    if strict_escalates(state) {
        worst = "Block";
    }
    if let Some(exit) = state.exit.as_ref().filter(|_| worst == "Approve") {
        return exit.verdict.clone();
    }
    match (state.not_run.is_empty(), worst) {
        (true, w) => w.into(),
        (false, "Approve") => "INCOMPLETE".into(),
        (false, w) => format!("{w} (INCOMPLETE)"),
    }
}

/// The findings that hold the verdict: the confirmed ones and the prior round's still open.
fn verdict_findings(state: &RunState) -> Vec<Value> {
    let confirmed = state
        .settled
        .iter()
        .filter(|f| Tier::of(f) == Tier::Confirmed)
        .cloned();
    confirmed.chain(state.chain.gating()).collect()
}

/// Whether strict mode's maintainability bar makes the verdict Block.
fn strict_escalates(state: &RunState) -> bool {
    crate::strict::blocks(state.context.strict, verdict_findings(state).iter())
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

/// The header lines: what was reviewed, each profile's plan and the lens rounds.
fn header(state: &RunState) -> String {
    let d = &state.diff;
    let short = |sha: &str| sha.get(..12).unwrap_or(sha).to_owned();
    let tree = if d.dirty {
        ", with uncommitted changes"
    } else {
        ", clean tree"
    };
    let taken: Vec<String> = state
        .tracks
        .iter()
        .map(|t| format!("{} {}", t.files.len(), lang(&t.profile)))
        .collect();
    let mut out = format!(
        "Head `{}`{tree}; base `{}` (merge-base `{}`), {} changed file(s){}.\n\n",
        d.head,
        d.base,
        short(&d.merge_base),
        d.files.len(),
        if taken.is_empty() {
            String::new()
        } else {
            format!(", {}", taken.join(", "))
        }
    );
    for t in &state.tracks {
        plan_lines(state, t, &mut out);
    }
    if state.tracks.iter().all(|t| t.plan.is_none()) {
        return out;
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

/// What a report calls a profile's files: its language.
fn lang(profile: &str) -> String {
    crate::profile::Profile::load(profile).map_or_else(|_| profile.to_owned(), |p| p.lang)
}

/// One track's plan: its size, depth, rounds, the lenses planned and those that ran, and what the
/// scout's surfaces dropped; named by its profile when the run has more than one.
fn plan_lines(state: &RunState, t: &Track, out: &mut String) {
    let Some(plan) = &t.plan else {
        return;
    };
    let depth = if state.light {
        "light pass"
    } else {
        "full review"
    };
    let whose = if state.tracks.len() > 1 {
        format!(" ({})", t.profile)
    } else {
        String::new()
    };
    let ran = state.rounds.ran(&t.profile, plan);
    out.push_str(&format!(
        "Plan{whose}: {} diff, {depth}, at most {} round(s). Lenses planned: {}; ran: {}.\n",
        plan.size_bucket,
        plan.max_rounds,
        plan.lenses.join(", "),
        if ran.is_empty() {
            "none".into()
        } else {
            ran.join(", ")
        },
    ));
    if !plan.metrics_dropped.is_empty() {
        out.push_str(&format!(
            "Dropped for want of a code-metrics index{whose}: {}.\n",
            plan.metrics_dropped.join(", ")
        ));
    }
    if !plan.surface_dropped.is_empty() {
        out.push_str(&format!(
            "Dropped by the scout's surfaces{whose}: {}.\n",
            plan.surface_dropped.join(", ")
        ));
    }
}

/// The Markdown report of a finished run: the verdict, then the findings grouped by tier, worst
/// first in each.
#[must_use]
pub fn markdown(state: &RunState, verdict: &str) -> String {
    let mut out = format!(
        "# craft review\n\n## Verdict\n\n{}\n\n{}",
        verdict_line(state, verdict),
        header(state)
    );
    out.push_str(&rereview::section(state));
    match state.exit.as_ref() {
        Some(exit) => listed(exit.listed.as_deref(), &state.diff.files, &mut out),
        None => listed(Some(NOT_COVERED), &state.uncovered, &mut out),
    }
    degraded(state, &mut out);
    out.push_str(&crate::gate::section(&state.gate));
    if state.exit.is_none() {
        findings(state, &mut out);
    }
    let in_verdict: Vec<Value> = state
        .chain
        .contradicting()
        .into_iter()
        .chain(
            state
                .settled
                .iter()
                .filter(|f| Tier::of(f) != Tier::Refuted)
                .cloned(),
        )
        .collect();
    out.push_str(&state.memory.report(&state.chain.deferred(), &in_verdict));
    out.push_str(&crate::tool::titles_section(&in_verdict));
    out.push_str(&crate::sources::section(
        &state.context.sources,
        &state.settled,
    ));
    out.push_str(&crate::critic::section(state));
    out.push_str(&crate::units::section(&state.units));
    out.push_str("\n## Not run\n\n");
    for n in &state.not_run {
        out.push_str(&format!("- {n}\n"));
    }
    out.push_str(&format!("- {}\n", light::cli_not_run(state)));
    if !state.notes.is_empty() {
        out.push_str("\n## Notes\n\n");
        for n in &state.notes {
            out.push_str(&format!("- {n}\n"));
        }
    }
    if state.light {
        out.push_str(&light::section(state));
    }
    out.push_str(&crate::extra::section(state));
    out
}

/// The heading of the changed files a run that reviewed code left out, as review.js names it.
const NOT_COVERED: &str = "Not reviewed (no language profile)";

/// The changed files under `heading`, when there is one and a file to list.
fn listed(heading: Option<&str>, files: &[String], out: &mut String) {
    let Some(heading) = heading.filter(|_| !files.is_empty()) else {
        return;
    };
    out.push_str(&format!("## {heading}\n\n"));
    for f in files {
        out.push_str(&format!("- {f}\n"));
    }
    out.push('\n');
}

/// How the run was weaker than asked, as its host said: before the findings, so they are read with it.
fn degraded(state: &RunState, out: &mut String) {
    if state.degraded.is_empty() {
        return;
    }
    out.push_str("## Degraded\n\nThe host ran part of this review weaker than it asked:\n\n");
    for d in &state.degraded {
        out.push_str(&format!("- {}\n", one_line(d)));
    }
    out.push('\n');
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
