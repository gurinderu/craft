//! The raise of a confirmed finding whose verified harm is must-fix, as `lib/harm-verify.mjs`
//! decides it (realm @nick/craft, node #407): the verifier is shown the harms a finding claims and
//! says which one the code shows.

use serde_json::Value;

use super::{REPO_RULE, ceiling, level_rank, note, rule_cited, text};

/// A harm a finding claims: its level, and that claim's own harm text and cited rule.
#[derive(Debug, Clone)]
struct Claim {
    level: String,
    harm: Option<String>,
    repo_rule: Option<Value>,
}

/// The harms `f` claims, worst first, one per known level: its `harmClaims`, or its own.
fn claims(f: &Value) -> Vec<Claim> {
    let own = [f.clone()];
    let raw = f
        .get("harmClaims")
        .and_then(Value::as_array)
        .map_or(&own[..], Vec::as_slice);
    union(raw)
}

impl Claim {
    /// The claim as a finding's `harmClaims` entry carries it.
    fn to_value(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("harmLevel".into(), Value::String(self.level.clone()));
        if let Some(h) = &self.harm {
            m.insert("harm".into(), Value::String(h.clone()));
        }
        if let Some(r) = &self.repo_rule {
            m.insert("repoRule".into(), r.clone());
        }
        Value::Object(m)
    }
}

/// The distinct harms `members` claim between them, worst first, as `groupClaims`.
pub(crate) fn group_claims<'a>(members: impl IntoIterator<Item = &'a Value>) -> Vec<Value> {
    let raw: Vec<Value> = members
        .into_iter()
        .flat_map(|m| claims(m).iter().map(Claim::to_value).collect::<Vec<_>>())
        .collect();
    union(&raw).iter().map(Claim::to_value).collect()
}

/// How many distinct harms `f` claims.
pub(crate) fn claim_count(f: &Value) -> usize {
    claims(f).len()
}

/// Whether any harm `f` claims could make it must-fix, as `mayBeMustFix`.
pub(crate) fn may_be_must_fix(f: &Value) -> bool {
    claims(f).iter().any(must_fix)
}

/// One claim per known level, worst first; at a level, one citing its rule wins.
fn union(raw: &[Value]) -> Vec<Claim> {
    let mut by: Vec<Claim> = Vec::new();
    for c in raw {
        let Some(level) = text(c, "harmLevel").filter(|l| ceiling(l).is_some()) else {
            continue;
        };
        let repo_rule = c.get("repoRule").cloned();
        // One claim per level; one that cites its rule wins over one that does not.
        if let Some(i) = by.iter().position(|h| h.level == level) {
            if by.get(i).is_some_and(|h| h.repo_rule.is_some()) || repo_rule.is_none() {
                continue;
            }
            by.remove(i);
        }
        by.push(Claim {
            level: level.to_owned(),
            harm: text(c, "harm").map(str::to_owned),
            repo_rule,
        });
    }
    by.sort_by_key(|c| level_rank(&c.level));
    by
}

fn must_fix(c: &Claim) -> bool {
    let level = if c.level == REPO_RULE && !rule_cited(c.repo_rule.as_ref()) {
        "none"
    } else {
        c.level.as_str()
    };
    ceiling(level) == Some("Critical")
}

/// The harm one verifier confirmed on `f`: the claim it names (`confirmedHarmLevel`, else the
/// worst claimed) when `harmSupported` is true, as `panelHarm` decides for a panel of one.
pub(crate) fn verified(f: &Value, vote: &Value) -> Option<String> {
    let cs = claims(f);
    if vote.get("harmSupported").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let named = match vote.get("confirmedHarmLevel") {
        None | Some(Value::Null) => cs.first().map(|c| c.level.as_str()),
        Some(v) => v.as_str(),
    }?;
    cs.iter()
        .find(|c| c.level == named)
        .map(|c| c.level.clone())
}

/// A confirmed `f` after its harm `level` was verified: it shows that claim, and goes to High
/// from Medium or below when that harm is must-fix.
pub(crate) fn raise(f: &Value, level: &str) -> Value {
    let Some(claim) = claims(f).into_iter().find(|c| c.level == level) else {
        return f.clone();
    };
    let mut out = f.as_object().cloned().unwrap_or_default();
    out.insert("harmLevel".into(), Value::String(claim.level.clone()));
    out.remove("harm");
    out.remove("repoRule");
    if let Some(h) = &claim.harm {
        out.insert("harm".into(), Value::String(h.clone()));
    }
    if let Some(r) = &claim.repo_rule {
        out.insert("repoRule".into(), r.clone());
    }
    let severity = text(f, "severity").unwrap_or("").to_owned();
    if must_fix(&claim) && matches!(severity.as_str(), "Medium" | "Low" | "Info") {
        out.insert("severity".into(), Value::String("High".into()));
        note(
            &mut out,
            format!(
                "raised to High from {severity}: verified harm — a verifier confirmed the {level} harm, which is must-fix"
            ),
        );
    }
    Value::Object(out)
}
