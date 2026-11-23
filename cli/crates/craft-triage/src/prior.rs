//! A prior run's ledger, passed back in for an idempotent re-run: a settled verdict is carried
//! rather than judged again; never one nothing judged nor one the sift set aside.

use std::collections::HashMap;
use std::hash::BuildHasher;

use serde_json::Value;

use crate::ledger::{LedgerEntry, UNJUDGED_MARKER};
use crate::sift::SIFT_MARK;

/// A value as JavaScript's `String()` writes it, for a field of the prior ledger the caller passed.
fn js_text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// The prior ledger by stable id, an entry read only as far as it is an object, its fields as
/// text; a later entry under one id replaces an earlier one.
#[must_use]
pub fn ledger_by_id(entries: &[Value]) -> HashMap<String, LedgerEntry> {
    let mut by_id = HashMap::new();
    for e in entries {
        let Some(x) = e.as_object() else { continue };
        let text_or_empty = |k: &str| match x.get(k) {
            None | Some(Value::Null) => String::new(),
            v => js_text(v),
        };
        let id = js_text(x.get("stable_id"));
        let row = LedgerEntry {
            stable_id: id.clone(),
            verdict: text_or_empty("verdict"),
            reason: text_or_empty("reason"),
            sifted: Some(x.get("sifted") == Some(&Value::Bool(true))),
            ..LedgerEntry::default()
        };
        by_id.insert(id, row);
    }
    by_id
}

/// The prior ledger's row for `id` when it settled the finding: a `reject`, `defer` or
/// `needs-decision` some agent judged; never one marked unjudged nor one the sift set aside.
#[must_use]
pub fn settled_prior<'a, S: BuildHasher>(
    prior: &'a HashMap<String, LedgerEntry, S>,
    id: &str,
) -> Option<&'a LedgerEntry> {
    let p = prior.get(id)?;
    if !["reject", "defer", "needs-decision"].contains(&p.verdict.as_str())
        || p.reason.contains(UNJUDGED_MARKER)
        || p.sifted == Some(true)
        || p.reason.contains(SIFT_MARK)
    {
        return None;
    }
    Some(p)
}

#[cfg(test)]
mod tests;
