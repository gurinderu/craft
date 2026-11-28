//! What became of a contradicting finding in its later round's ledger.

use crate::js::{Js, JsString};

use super::Tally;

/// Counts one finding's fate: `later` is `None` with no later round, else its ledger.
pub(super) fn fate(t: &mut Tally, fp: &JsString, later: Option<&Option<Js>>) {
    let Some(ledger) = later else {
        if fp.is_empty() {
            t.unknown += 1;
        } else {
            t.no_later_round += 1;
        }
        return;
    };
    let rows = ledger.as_ref().and_then(Js::as_arr);
    let row = rows.filter(|_| !fp.is_empty()).and_then(|rows| {
        rows.iter()
            .filter_map(Js::as_obj)
            .find(|e| e.get("fp") == Some(&Js::Str(fp.clone())))
    });
    match row.and_then(|r| r.get("disposition")) {
        Some(Js::Str(d)) if *d == *"closed" => t.fixed += 1,
        Some(Js::Str(d)) if *d == *"open" => t.open += 1,
        Some(Js::Str(_)) => t.set_aside += 1,
        _ => t.unknown += 1,
    }
}
