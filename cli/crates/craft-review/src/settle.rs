//! What a panel of verifier votes makes of its finding, as `tierFromVotes`, `decideTier`,
//! `votePanel`, `panelHarm`, `harmRaise` and the harm cap of `lib/review-verify.mjs`,
//! `lib/harm-verify.mjs` and `lib/harm-cap.mjs` decide it: off-schema votes discarded before the
//! majority, the tier by majority, the premise and reach demotions, the verified-harm raise, then
//! the cap (realm @nick/craft, nodes #379, #407). `content/parity/verify-cases.json` holds both
//! ports to the same answers.

use serde_json::{Map, Value};

use crate::harm;

/// Where a finding stands after verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// A majority found the claim at the cited line and its premise held.
    Confirmed,
    /// The claim stands at the line but did not hold up confidently.
    Suspected,
    Refuted,
    /// Nothing checked it against the code: no verifier was spent, or none returned a judgement.
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

    /// The tier a settled finding carries in its `tier` field; none is unverified.
    #[must_use]
    pub fn of(f: &Value) -> Self {
        match f.get("tier").and_then(Value::as_str) {
            Some("confirmed") => Self::Confirmed,
            Some("suspected") => Self::Suspected,
            Some("refuted") => Self::Refuted,
            _ => Self::Unverified,
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

/// The four judgements the tier is decided on, as `VOTE_AXES`.
const AXES: [&str; 4] = [
    "refuted",
    "citedLineMatches",
    "reachable",
    "premiseSupported",
];

fn says(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool) == Some(true)
}

/// Whether a vote carries every judgement as a boolean (`isVerdictShaped`).
pub(crate) fn shaped(v: &Value) -> bool {
    AXES.iter()
        .all(|k| v.get(*k).is_some_and(Value::is_boolean))
}

/// Whether two votes say the same on every axis (`votesAgree`); an off-schema one never agrees.
pub(crate) fn agree(a: &Value, b: &Value) -> bool {
    shaped(a) && shaped(b) && AXES.iter().all(|k| a.get(*k) == b.get(*k))
}

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

fn with(f: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut out: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    for (k, v) in fields {
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}

fn noted(f: &Value, note: &str) -> Value {
    Value::String(format!("{} ({note})", text(f, "why")))
}

/// `f` that nothing checked against the code, and why (`NOT_VERIFIED`).
pub(crate) fn not_verified(f: &Value, why: &str) -> Value {
    with(
        f,
        vec![
            ("tier", "unverified".into()),
            ("why", noted(f, &format!("NOT VERIFIED: {why}"))),
        ],
    )
}

/// `f` after its panel, the votes as they came back and `None` for one that died
/// (`tierFromVotes`): off-schema votes are discarded before the arithmetic, and a discard is said.
#[must_use]
pub fn tier_from_votes(f: &Value, votes: &[Option<Value>]) -> Value {
    let live: Vec<&Value> = votes.iter().flatten().collect();
    let v: Vec<&Value> = live.iter().copied().filter(|x| shaped(x)).collect();
    let judged = decide(f, live.len(), &v);
    let discarded = live.len() - v.len();
    if discarded == 0 {
        return judged;
    }
    let count = ("votesDiscarded", Value::from(discarded));
    if Tier::of(&judged) == Tier::Unverified {
        return with(&judged, vec![count]);
    }
    let share = match (v.len() * 2).cmp(&live.len()) {
        std::cmp::Ordering::Less => "a minority of",
        std::cmp::Ordering::Equal => "exactly half of",
        std::cmp::Ordering::Greater => "most of",
    };
    let note = format!(
        "PANEL THINNED: {discarded} of {n} returned votes answered off-schema and were discarded before the arithmetic — this {tier} stands on {kept} of {n} returned votes, {share} the panel that answered",
        n = live.len(),
        tier = text(&judged, "tier"),
        kept = v.len(),
    );
    let why = noted(&judged, &note);
    with(&judged, vec![count, ("why", why)])
}

/// The majority over the shaped votes `v` (`decideTier`, `votePanel`); `live` counts every
/// returned vote.
fn decide(f: &Value, live: usize, v: &[&Value]) -> Value {
    if v.is_empty() {
        return not_verified(
            f,
            if live > 0 {
                "the verifier ANSWERED OFF-SCHEMA — its verdict carried none of the judgements this tier is decided on, so nothing was checked against the code"
            } else {
                "every verifier vote for this finding died before returning a verdict — nothing was checked against the code"
            },
        );
    }
    let n = v.len();
    let held = |k: &str| v.iter().filter(|x| says(x, k)).count() >= n.div_ceil(2);
    let refutes = v.iter().filter(|x| says(x, "refuted")).count();
    let tier = if !held("citedLineMatches") || refutes * 2 > n {
        Tier::Refuted
    } else if refutes == 0 {
        Tier::Confirmed
    } else {
        Tier::Suspected
    };
    if tier == Tier::Confirmed && !held("premiseSupported") {
        return premise_demoted(f);
    }
    if tier == Tier::Confirmed && !held("reachable") {
        return reach_demoted(f);
    }
    let mut fields = vec![("tier", Value::from(tier.name()))];
    if tier == Tier::Confirmed
        && let Some(level) = harm::raise::panel_harm(f, v)
    {
        fields.push(("harmVerified", Value::String(level)));
    }
    with(f, fields)
}

/// A confirmed finding whose off-site premise no verifier pinned: Suspected (`premiseDemoted`).
fn premise_demoted(f: &Value) -> Value {
    let at = match text(f, "whereChecked") {
        "" => ", and whereChecked was empty".to_owned(),
        w => format!(" — claimed at {w}"),
    };
    let note = format!(
        "demoted to Suspected: the load-bearing premise is off-site and no verifier could pin it to real code{at}"
    );
    with(
        f,
        vec![("tier", "suspected".into()), ("why", noted(f, &note))],
    )
}

/// A confirmed finding off every production-reachable path: one severity lower (`reachDemoted`),
/// without the path floor's note, which claims a Medium that no longer holds.
fn reach_demoted(f: &Value) -> Value {
    let from = text(f, "severity");
    let to = demote(from).unwrap_or(from);
    let why = text(f, "why");
    let why = why.replacen(harm::floor_note(why), "", 1);
    let why = format!("{why} (severity demoted {from}→{to}: not on a production-reachable path)");
    with(
        f,
        vec![
            ("tier", "confirmed".into()),
            ("severity", to.into()),
            ("why", why.into()),
        ],
    )
}

/// A settled finding as it is reported: the verified-harm raise, then the harm cap
/// (`capByHarm(harmRaise(f))`).
#[must_use]
pub fn finalize(f: &Value) -> Value {
    let level = f
        .get("harmVerified")
        .and_then(Value::as_str)
        .filter(|_| Tier::of(f) == Tier::Confirmed);
    let raised = level.map_or_else(|| f.clone(), |l| harm::raise::raise(f, l));
    harm::cap(&raised)
}
