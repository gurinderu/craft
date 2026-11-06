//! What a verifier's verdict makes of its finding, as `decideTier`, `harmRaise` and the harm cap
//! of `lib/review-verify.mjs`, `lib/harm-verify.mjs` and `lib/harm-cap.mjs` decide it for a panel of
//! one: the tier, then the reach demotion or the verified-harm raise, then the cap
//! (realm @nick/craft, nodes #379, #407). `content/parity/verify-cases.json` holds both ports to
//! the same answers.

use serde_json::{Map, Value};

use crate::harm;

/// Where a finding stands after verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// The verifier found the claim at the cited line and its premise held.
    Confirmed,
    /// The claim stands at the line but its off-site premise was not shown.
    Suspected,
    Refuted,
    /// No verdict came back, or one off its schema.
    Unverified,
}

impl Tier {
    /// The tier as the engines name it.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Suspected => "suspected",
            Self::Refuted => "refuted",
            Self::Unverified => "unverified",
        }
    }
}

/// One step lower, as `DEMOTE` in `lib/review-verify.mjs`; an unknown severity is kept.
pub(crate) fn demote(severity: &str) -> Option<&'static str> {
    match severity {
        "Critical" => Some("High"),
        "High" => Some("Medium"),
        "Medium" => Some("Low"),
        "Low" | "Info" => Some("Info"),
        _ => None,
    }
}

/// The tier a shaped verdict gives, and whether its finding's path is reachable; `None` when the
/// verdict lacks one of the four booleans (`isVerdictShaped`).
fn judge(v: &Value) -> Option<(Tier, bool)> {
    let says = |k: &str| v.get(k).and_then(Value::as_bool);
    let (refuted, line, reach, premise) = (
        says("refuted")?,
        says("citedLineMatches")?,
        says("reachable")?,
        says("premiseSupported")?,
    );
    let tier = match (refuted || !line, premise) {
        (true, _) => Tier::Refuted,
        (false, false) => Tier::Suspected,
        (false, true) => Tier::Confirmed,
    };
    Some((tier, reach))
}

/// The tier a verdict gives its finding.
#[must_use]
pub fn tier(vote: Option<&Value>) -> Tier {
    vote.and_then(judge).map_or(Tier::Unverified, |(t, _)| t)
}

/// A finding after its verdict: its tier, and the finding with its final severity and the notes on
/// how it got there in `why`.
#[must_use]
pub fn settle(finding: &Value, vote: Option<&Value>) -> (Tier, Value) {
    let Some((tier, reach)) = vote.and_then(judge) else {
        return (Tier::Unverified, harm::cap(finding));
    };
    let mut f = finding.clone();
    if tier == Tier::Confirmed && !reach {
        f = reach_demoted(&f);
    } else if let Some(level) = vote
        .filter(|_| tier == Tier::Confirmed)
        .and_then(|v| harm::raise::verified(&f, v))
    {
        f = harm::raise::raise(&f, &level);
    }
    (tier, harm::cap(&f))
}

/// A confirmed finding off every production-reachable path: one severity lower.
fn reach_demoted(f: &Value) -> Value {
    let mut out: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let from = f.get("severity").and_then(Value::as_str).unwrap_or("");
    if let Some(to) = demote(from) {
        let why = out.get("why").and_then(Value::as_str).unwrap_or("");
        let why =
            format!("{why} (severity demoted {from}→{to}: not on a production-reachable path)");
        out.insert("severity".into(), Value::String(to.to_owned()));
        out.insert("why".into(), Value::String(why));
    }
    Value::Object(out)
}
