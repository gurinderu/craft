//! What a report says about the round it was in its branch's chain: which round, what it built on,
//! what its lenses reviewed, and what became of each finding the prior round left.

use crate::prompts::ReScope;
use crate::rereview::{Fate, PriorFinding};
use crate::state::RunState;

/// One line on the round: its number and what it built on and reviewed.
pub(crate) fn rereview_line(state: &RunState) -> String {
    let c = &state.chain;
    let Some(prior) = &c.prior else {
        let why = c.unchained.as_deref().unwrap_or("no chain was read");
        return format!("round {}, a first review ({why})", c.round.max(1));
    };
    let head = prior.head.get(..12).unwrap_or(&prior.head);
    let scope = match (&state.context.re_review, &c.rescan) {
        (ReScope::Fixes, _) => format!("its lenses reviewed only the fix commits since `{head}`"),
        (_, Some(why)) => format!("its lenses reviewed the whole diff again: {why}"),
        (_, None) => "its lenses reviewed the whole diff again".into(),
    };
    format!(
        "round {} of this branch, building on round {} at `{head}` (run {}); {scope}",
        c.round, prior.round, prior.dir
    )
}

fn label(fate: Fate) -> &'static str {
    match fate {
        Fate::Resolved => "Resolved",
        Fate::Pending | Fate::StillOpen => "Still open",
        Fate::Regressed => "Regressed",
        Fate::Carried => "Carried (set aside by its author)",
        Fate::Unverified => "Carried unverified (never checked against the code)",
    }
}

fn entry(p: &PriorFinding) -> String {
    let r = &p.row;
    let mut e = format!(
        "- {}: **{}** `{}:{}` — {}\n",
        label(p.fate),
        r.severity,
        r.file,
        r.line,
        r.title.replace('\n', " ")
    );
    if p.fate != Fate::Resolved {
        e.push_str(&format!("  - Why: {}\n", r.why.replace('\n', " ")));
    }
    e
}

/// The report's re-review section: the round, and each prior finding with its fate; the still
/// open and regressed ones hold the verdict by their severity, as a new confirmed finding would.
pub(crate) fn section(state: &RunState) -> String {
    let c = &state.chain;
    let mut out = format!("## Re-review\n\nThis is {}.\n", rereview_line(state));
    if c.prior.is_none() {
        out.push('\n');
        return out;
    }
    let [resolved, open, regressed, carried, unverified] = c.tally();
    out.push_str(&format!(
        "\nThe prior round's findings: {resolved} resolved, {open} still open, {regressed} regressed, {carried} carried, {unverified} carried unverified; {} tombstone(s) of resolved findings carried. Still-open and regressed ones count toward the verdict by their severity.\n\n",
        c.tombstones.len()
    ));
    for p in &c.priors {
        out.push_str(&entry(p));
    }
    if !c.priors.is_empty() {
        out.push('\n');
    }
    out
}
