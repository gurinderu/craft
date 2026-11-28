//! The audit's report as Markdown: the `## Verdict` block first, what was read, then the findings
//! that stand, worst first.

use std::path::Path;

use craft_review::settle::Tier;
use serde_json::Value;

use super::{Summary, UNREAD, UNVERIFIED};
use crate::state::AuditState;

fn field<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

fn rank(f: &Value) -> usize {
    ["Critical", "High", "Medium", "Low", "Info"]
        .iter()
        .position(|s| *s == field(f, "severity"))
        .unwrap_or(9)
}

/// One finding as a report entry.
#[must_use]
pub fn entry(f: &Value) -> String {
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let mut e = format!(
        "- **{}** `{}:{line}` — {} ({})\n  - Why: {}\n",
        field(f, "severity"),
        field(f, "file"),
        field(f, "title"),
        field(f, "source"),
        field(f, "why").replace('\n', " "),
    );
    let fix = field(f, "fix");
    if !fix.is_empty() {
        e.push_str(&format!("  - Fix: {}\n", fix.replace('\n', " ")));
    }
    e
}

/// The entries of the findings of `tier` worth listing, worst first, under `title`; "" for none.
fn section(sum: &Summary, title: &str, tier: Tier) -> String {
    let mut list: Vec<&Value> = sum
        .settled
        .iter()
        .filter(|f| Tier::of(f) == tier && !craft_review::report::unverified::held(f))
        .collect();
    if list.is_empty() {
        return String::new();
    }
    list.sort_by_key(|f| rank(f));
    let body: String = list.into_iter().map(entry).collect();
    format!("\n## {title}\n\n{body}")
}

/// What the audit read and what it did not, one line each.
fn coverage(dir: &Path, s: &AuditState, sum: &Summary) -> String {
    let audited = s.scout.audited();
    let mut out = format!(
        "- Files: {} of {audited} read, of {} tracked; {} outside every profile (project configuration, prose, images).\n",
        audited - sum.unread.len().min(audited),
        s.scout.tracked,
        s.scout.outside.len(),
    );
    if !sum.unread.is_empty() {
        out.push_str(&format!(
            "- Unread: {} file(s), listed in `{UNREAD}` beside this report — a lens agent the budget did not buy, or one that gave no answer. Resume the run to read them: `{}`.\n",
            sum.unread.len(),
            craft_step::stop::resume("audit", dir),
        ));
    }
    if sum.unjudged() > 0 {
        out.push_str(&format!(
            "- Unjudged: {} finding(s) at Medium or above whose verifier gave no verdict; a resume hands them to a new one: `{}`.\n",
            sum.unjudged(),
            craft_step::stop::resume("audit", dir),
        ));
    }
    out.push_str(&format!(
        "- Lens agents: {} of {} answered, in {} pass(es).\n",
        sum.answered, sum.jobs, s.pass
    ));
    let [c, su, r, u] = sum.tiers();
    out.push_str(&format!(
        "- Findings: {c} confirmed, {su} suspected, {r} refuted, {u} unverified.\n"
    ));
    let held = sum.held().len();
    if held > 0 {
        out.push_str(&format!(
            "- {held} Low or Info finding(s) no verifier checked are not listed here: they are in `{UNVERIFIED}` beside this report.\n"
        ));
    }
    for (profile, left) in sum.left.iter().filter(|(_, l)| !l.is_empty()) {
        out.push_str(&format!(
            "- Lenses of {profile} an audit does not run: {}.\n",
            left.join(", ")
        ));
    }
    out
}

/// The report of the audit `s` in `dir` as `sum` says it, `lost` the writes that did not land.
#[must_use]
pub fn markdown(dir: &Path, s: &AuditState, sum: &Summary, lost: &[String]) -> String {
    let mut out = String::from("# craft audit\n\n");
    for l in lost {
        out.push_str(&format!("> **Not filed**: {l}\n"));
    }
    if !lost.is_empty() {
        out.push('\n');
    }
    out.push_str(&format!("## Verdict\n\n**{}**\n\n", sum.verdict));
    out.push_str(&coverage(dir, s, sum));
    out.push_str(&section(sum, "Confirmed", Tier::Confirmed));
    out.push_str(&section(sum, "Suspected", Tier::Suspected));
    out.push_str(&section(
        sum,
        "Unverified at Medium and above (their verifier gave no verdict)",
        Tier::Unverified,
    ));
    out
}
