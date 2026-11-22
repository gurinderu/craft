//! A version's lens rounds summed across its runs (realm @nick/craft, node #248): what each round
//! raised (`raw`), what it raised first that survived the dedup (`newUnique`), what of that
//! verification confirmed (`confirmed`) and how much of it was Medium or above
//! (`confirmedMediumPlus`), from each record's `lensRounds` rows; beside them the confirmed of the
//! gate's seeds (`seedYield`) and of no lens round (`unattributedConfirmed`). A row or field
//! without them — a record written before they were kept, or a run ended before its
//! verification — adds nothing.

use std::collections::BTreeMap;

use crate::js::{Js, Obj};

/// One round's sums over the runs whose rows carried its yield.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Round {
    pub runs: u64,
    pub raw: f64,
    pub new_unique: f64,
    pub confirmed: f64,
    pub confirmed_medium_plus: f64,
}

/// The confirmed no lens round raised, over the runs that counted them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Apart {
    pub seed_runs: u64,
    pub seed_confirmed: f64,
    pub seed_medium_plus: f64,
    pub unattributed_runs: u64,
    pub unattributed_confirmed: f64,
}

impl Apart {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.seed_runs == 0 && self.unattributed_runs == 0
    }
}

/// A finite, non-negative number at `k`.
fn count(row: &Obj, k: &str) -> Option<f64> {
    row.get(k)
        .and_then(Js::as_num)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

/// The round a row names, when it is a whole number.
fn round_of(row: &Obj) -> Option<u64> {
    let n = count(row, "round").filter(|n| n.fract() == 0.0)?;
    format!("{n}").parse().ok()
}

/// Adds the record's `lensRounds` rows that carry a round's yield to `rounds`.
pub(super) fn add(r: &Obj, rounds: &mut BTreeMap<u64, Round>) {
    let rows = r.get("lensRounds").and_then(Js::as_arr).unwrap_or(&[]);
    for row in rows.iter().filter_map(Js::as_obj) {
        let (Some(round), Some(raw), Some(new_unique), Some(confirmed), Some(plus)) = (
            round_of(row),
            count(row, "raw"),
            count(row, "newUnique"),
            count(row, "confirmed"),
            count(row, "confirmedMediumPlus"),
        ) else {
            continue;
        };
        let sum = rounds.entry(round).or_default();
        sum.runs += 1;
        sum.raw += raw;
        sum.new_unique += new_unique;
        sum.confirmed += confirmed;
        sum.confirmed_medium_plus += plus;
    }
}

/// Adds the record's seeds' and unattributed confirmed to `apart`.
pub(super) fn add_apart(r: &Obj, apart: &mut Apart) {
    let seeds = r.get("seedYield").and_then(Js::as_obj);
    let seed = seeds.and_then(|s| count(s, "confirmed").zip(count(s, "confirmedMediumPlus")));
    if let Some((c, plus)) = seed {
        apart.seed_runs += 1;
        apart.seed_confirmed += c;
        apart.seed_medium_plus += plus;
    }
    if let Some(c) = count(r, "unattributedConfirmed") {
        apart.unattributed_runs += 1;
        apart.unattributed_confirmed += c;
    }
}

#[cfg(test)]
mod tests;
