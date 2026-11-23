//! The sorting before publication, as `integrations/shared/finding-sort.mjs` sorts (realm @nick/craft, nodes #270,
//! #277, #282, #423): each finding a PR comment could carry is a defect, posted as it is, or
//! doubtful — not confirmed; raised by the compat, intent or api-boundary lens; speaking of
//! rollback, rollout, old replicas, migration or a breaking change; its line outside the lines the
//! diff changed; the design lens's alone with no harm named — and waits for the reviewer. A
//! confirmed finding going against a memory record is a defect whatever the other signs say; an
//! unconfirmed one is doubtful, the record named first.

use craft_store::js::JsStr;
use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::gate::lines::Lines;
use crate::memory::contradiction_of;
use crate::tool::finding_lenses;

/// The lenses whose findings turn on the author's intent or on parties outside the diff.
const DOUBT_LENSES: [&str; 3] = ["compat", "intent", "api-boundary"];
/// Why a finding whose line the diff did not change is doubtful.
pub(super) const OUTSIDE_REASON: &str = "its line is outside the lines the diff changed";

/// Rollback, rollout, old replicas, migration, a breaking change — `DOUBT_WORDS`, word boundaries
/// ASCII as JavaScript's are.
static DOUBT_WORDS: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(?-u:\b)(?:roll(?:ed|ing)?[ -]?backs?|roll(?:ed|ing)?[ -]?outs?|rolling (?:deploy|upgrade|update|restart)s?|(?:old|older|stale) replicas?|migrat(?:e|es|ed|ing|ion|ions)|breaking[ -]changes?)(?-u:\b)",
    )
    .ok()
});

/// A field as `String(v ?? '')` reads it.
pub(super) fn text(f: &Value, k: &str) -> String {
    crate::js::text(f.get(k))
}

/// The finding's tier, lower-cased; none — confirmed (`sortTier`).
#[must_use]
pub(crate) fn sort_tier(f: &Value) -> String {
    match f.get("tier") {
        None | Some(Value::Null) => "confirmed".into(),
        Some(_) => text(f, "tier").to_lowercase(),
    }
}

/// A finding's line when it is a positive whole number, else 0 (`findingLine`).
pub(super) fn line(f: &Value) -> u32 {
    let n = crate::js::number(f.get("line"), f64::NAN);
    if n.fract() == 0.0 && n >= 1.0 && n <= f64::from(u32::MAX) {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a whole number between 1 and u32::MAX, checked above"
        )]
        return n as u32;
    }
    0
}

/// Whether the finding's line is one the diff changed: `None` when that cannot be told — the
/// changed lines unknown, or no file or line to look up (`lineInDiff`).
pub(super) fn in_diff(changed: Option<&Lines>, f: &Value) -> Option<bool> {
    let (file, n) = (text(f, "file"), line(f));
    let changed = changed.filter(|_| !file.is_empty() && n > 0)?;
    Some(changed.touches(&file, n))
}

/// Why a finding is doubtful, one reason per sign that holds; empty — a defect (`doubtReasons`).
/// `changed` `None`: the outside-the-diff sign cannot be told and is not applied.
#[must_use]
pub(crate) fn doubt_reasons(f: &Value, changed: Option<&Lines>) -> Vec<String> {
    let tier = sort_tier(f);
    let mut lenses: Vec<String> = Vec::new();
    for l in finding_lenses(f) {
        if DOUBT_LENSES.contains(&l.as_str()) && !lenses.contains(&l) {
            lenses.push(l);
        }
    }
    let mut out = Vec::new();
    if tier != "confirmed" {
        out.push(format!("not confirmed ({tier})"));
    }
    if !lenses.is_empty() {
        out.push(format!("raised by the {} lens", lenses.join(", ")));
    }
    if design_question(f) {
        out.push(DESIGN_REASON.into());
    }
    let said = format!("{} {}", text(f, "title"), text(f, "why"));
    if DOUBT_WORDS.as_ref().is_some_and(|re| re.is_match(&said)) {
        out.push(
            "it speaks of rollback, rollout, old replicas, migration or a breaking change".into(),
        );
    }
    if in_diff(changed, f) == Some(false) {
        out.push(OUTSIDE_REASON.into());
    }
    out
}

/// Why a design finding that names no harm is doubtful: a legitimate trade-off is a question to the
/// author, not a defect (realm @nick/craft, node #534).
const DESIGN_REASON: &str = "a design question for the author: the design lens named no harm";

/// Whether `f` is the design lens's alone and names no harm (`harmLevel` none or absent): a
/// second implementation or a broken boundary names one and stays a defect.
fn design_question(f: &Value) -> bool {
    let lenses = finding_lenses(f);
    let harm = text(f, "harmLevel");
    !lenses.is_empty()
        && lenses.iter().all(|l| l == crate::design::LENS)
        && matches!(harm.js_trim(), "" | "none")
}

/// The findings split for publication (`sortFindings`): the defects, and the doubtful ones each
/// with its reasons. One set aside by a decision or covered by a rule (`priorDecision`) is in neither.
pub(super) fn sort(
    findings: &[Value],
    changed: Option<&Lines>,
) -> (Vec<Value>, Vec<(Value, Vec<String>)>) {
    let mut defect = Vec::new();
    let mut doubtful = Vec::new();
    for f in findings {
        if f.get("priorDecision")
            .and_then(Value::as_str)
            .is_some_and(|d| !d.is_empty())
        {
            continue;
        }
        let c = contradiction_of(f);
        if c.is_some() && sort_tier(f) == "confirmed" {
            defect.push(f.clone());
            continue;
        }
        let mut reasons: Vec<String> = c
            .map(|(id, kind, why)| {
                let kind = if kind.is_empty() {
                    "record".into()
                } else {
                    kind
                };
                format!("goes against memory {kind} {id}: {why}")
            })
            .into_iter()
            .collect();
        reasons.extend(doubt_reasons(f, changed));
        if reasons.is_empty() {
            defect.push(f.clone());
        } else {
            doubtful.push((f.clone(), reasons));
        }
    }
    (defect, doubtful)
}

/// A doubtful finding as the run record keeps it, numbered from 1 (`postable`): what
/// `craft review post` builds its comment from (`super::doubtful`).
pub(super) fn postable(f: &Value, i: usize, reasons: &[String]) -> Value {
    json!({
        "n": i + 1, "severity": text(f, "severity"), "title": text(f, "title"), "file": text(f, "file"),
        "line": line(f), "why": text(f, "why"), "fix": text(f, "fix"), "source": text(f, "source"),
        "toolRule": text(f, "toolRule"), "outsideDiff": reasons.iter().any(|r| r == OUTSIDE_REASON),
    })
}
