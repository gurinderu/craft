//! A version's lens rounds summed across its runs: what each round raised (`raw`), what it raised
//! first that survived the dedup (`newUnique`) and what of that verification confirmed
//! (`confirmed`), from each record's `lensRounds` rows. A row without all three — a record written
//! before they were kept, or a run ended before its verification — adds nothing.

use std::collections::BTreeMap;

use crate::js::{Js, Obj};

/// One round's sums over the runs whose rows carried its yield.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Round {
    pub runs: u64,
    pub raw: f64,
    pub new_unique: f64,
    pub confirmed: f64,
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
        let (Some(round), Some(raw), Some(new_unique), Some(confirmed)) = (
            round_of(row),
            count(row, "raw"),
            count(row, "newUnique"),
            count(row, "confirmed"),
        ) else {
            continue;
        };
        let sum = rounds.entry(round).or_default();
        sum.runs += 1;
        sum.raw += raw;
        sum.new_unique += new_unique;
        sum.confirmed += confirmed;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{Round, add};
    use crate::js::parse;

    fn record(text: &str) -> crate::js::Obj {
        parse(text).unwrap().as_obj().unwrap().clone()
    }

    #[test]
    fn each_round_sums_the_rows_that_carry_its_yield_and_passes_over_the_rest() {
        let mut rounds = BTreeMap::new();
        add(
            &record(
                r#"{"lensRounds": [{"round": 1, "raw": 10, "newUnique": 4, "confirmed": 2},
                                    {"round": 2, "raw": 8, "newUnique": 1, "confirmed": 0},
                                    {"round": 3, "raw": 2, "newUnique": 1}, "not a row"]}"#,
            ),
            &mut rounds,
        );
        add(
            &record(r#"{"lensRounds": [{"round": 1, "raw": 6, "newUnique": 2, "confirmed": 1}]}"#),
            &mut rounds,
        );
        let one = Round {
            runs: 2,
            raw: 16.0,
            new_unique: 6.0,
            confirmed: 3.0,
        };
        assert_eq!(rounds.get(&1), Some(&one));
        assert_eq!(rounds.get(&2).map(|r| r.runs), Some(1));
        assert_eq!(
            rounds.get(&3),
            None,
            "a run ended before verification adds nothing"
        );
    }

    #[test]
    fn an_old_record_without_the_yield_adds_nothing() {
        let mut rounds = BTreeMap::new();
        add(
            &record(
                r#"{"lensRounds": [{"round": 1, "agents": 3, "returned": 3, "newFindings": 2}]}"#,
            ),
            &mut rounds,
        );
        add(&record(r#"{"verdict": "Approve"}"#), &mut rounds);
        assert!(rounds.is_empty());
    }
}
