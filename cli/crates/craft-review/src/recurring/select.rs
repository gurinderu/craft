use craft_store::js::{Js, Obj};

use super::read::Row;
use super::text::{text, touched};

/// The ledger's open rows within `paths`, as (verified real, no verifier's word): a settled or
/// dismissed row is neither (realm @nick/craft, #205, #636).
pub(super) fn rows(ledger: &[Js], paths: &[String]) -> (Vec<Row>, Vec<Row>) {
    let (mut real, mut unverified) = (vec![], vec![]);
    for o in ledger.iter().filter_map(Js::as_obj) {
        let row = Row {
            file: text(o, "file"),
            title: text(o, "title"),
            severity: text(o, "severity"),
            line: line(o),
        };
        if row.file.is_empty() || row.title.is_empty() || settled(o) || !touched(&row.file, paths) {
            continue;
        }
        let tier = text(o, "tier");
        if tier == "confirmed" {
            real.push(row);
        } else if tier == "unverified" {
            unverified.push(row);
        }
    }
    (real, unverified)
}

fn settled(o: &Obj) -> bool {
    let disposition = text(o, "disposition");
    ["rejected", "justified", "covered", "deferred"]
        .iter()
        .any(|d| disposition == *d)
        || (disposition == "closed" && text(o, "why").starts_with("dismissed "))
}

/// The row's 1-based line; 0 when it names none a diff can be held to.
fn line(o: &Obj) -> u32 {
    match o.get("line") {
        Some(Js::Num(n)) if *n >= 1.0 && n.fract() == 0.0 && *n <= f64::from(u32::MAX) => {
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "integral, positive and within u32, checked above"
            )]
            let n = *n as u32;
            n
        }
        _ => 0,
    }
}
