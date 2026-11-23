//! A prior run's ledger, passed back in for an idempotent re-run: a settled verdict is carried
//! rather than judged again; never one nothing judged nor one the sift set aside.

use std::collections::HashMap;
use std::hash::BuildHasher;

use craft_store::js::{Js, Obj};

use crate::field;
use crate::ledger::{Row, UNJUDGED_MARKER};
use crate::sift::SIFT_MARK;

/// The prior ledger by stable id, as `ledgerById`: an entry read only as far as it is an object,
/// its id, verdict and reason as `String()` writes them (a missing or null verdict and reason
/// ''), `sifted` true only when it is `true`; a later entry under one id replaces an earlier one.
#[must_use]
pub fn ledger_by_id(entries: &[Js]) -> HashMap<String, Row> {
    let mut by_id = HashMap::new();
    for e in entries {
        let Some(x) = e.as_obj() else { continue };
        let id = x
            .get("stable_id")
            .map_or_else(|| "undefined".into(), field::string);
        let row = Obj::new()
            .with("stable_id", Js::str(id.as_str()))
            .with("verdict", Js::str(field::or_empty(x, "verdict")))
            .with("reason", Js::str(field::or_empty(x, "reason")))
            .with("sifted", Js::Bool(x.get("sifted") == Some(&Js::Bool(true))));
        by_id.insert(id, Row(row));
    }
    by_id
}

/// The prior ledger's row for `id` when it settled the finding: a `reject`, `defer` or
/// `needs-decision` some agent judged; never one marked unjudged nor one the sift set aside.
#[must_use]
pub fn settled_prior<'a, S: BuildHasher>(
    prior: &'a HashMap<String, Row, S>,
    id: &str,
) -> Option<&'a Row> {
    let p = prior.get(id)?;
    let reason = p.text("reason");
    if !["reject", "defer", "needs-decision"].contains(&p.verdict())
        || reason.contains(UNJUDGED_MARKER)
        || field::truthy(&p.0, "sifted")
        || reason.contains(SIFT_MARK)
    {
        return None;
    }
    Some(p)
}

#[cfg(test)]
mod tests;
