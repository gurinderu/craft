//! The retro's lens rounds: one line per round, what it raised, what of that it raised first and
//! the dedup kept, what of that verification confirmed and how much of it was Medium or above;
//! then one line for the confirmed of the gate's seeds and of no lens round. Nothing when no record
//! carried them.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::Retro;

use super::super::{line, num};

/// The rounds as text, under their own heading, when any record carried a round's yield.
pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    if r.rounds.is_empty() && r.apart.is_empty() {
        return Ok(());
    }
    writeln!(out, "\nLens rounds (raw → new unique → confirmed, Medium+)")?;
    for (round, y) in &r.rounds {
        writeln!(
            out,
            "round {round}: {} → {} → {}, Medium+ {} over {} run(s)",
            num(y.raw),
            num(y.new_unique),
            num(y.confirmed),
            num(y.confirmed_medium_plus),
            y.runs
        )?;
    }
    let a = &r.apart;
    if !a.is_empty() {
        writeln!(
            out,
            "seeds: {} confirmed, Medium+ {} over {} run(s) · no lens round: {} confirmed over {} run(s)",
            num(a.seed_confirmed),
            num(a.seed_medium_plus),
            a.seed_runs,
            num(a.unattributed_confirmed),
            a.unattributed_runs
        )?;
    }
    Ok(())
}

/// The rounds as NDJSON lines, section `lensRound`.
pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a round or run count is far below 2^52"
    )]
    let n = |c: u64| Js::Num(c as f64);
    for (round, y) in &r.rounds {
        let o = Obj::new()
            .with("section", Js::str("lensRound"))
            .with("round", n(*round))
            .with("runs", n(y.runs))
            .with("raw", Js::Num(y.raw))
            .with("newUnique", Js::Num(y.new_unique))
            .with("confirmed", Js::Num(y.confirmed))
            .with("confirmedMediumPlus", Js::Num(y.confirmed_medium_plus));
        line(out, o)?;
    }
    let a = &r.apart;
    if a.is_empty() {
        return Ok(());
    }
    let o = Obj::new()
        .with("section", Js::str("roundYieldApart"))
        .with("seedRuns", n(a.seed_runs))
        .with("seedConfirmed", Js::Num(a.seed_confirmed))
        .with("seedConfirmedMediumPlus", Js::Num(a.seed_medium_plus))
        .with("unattributedRuns", n(a.unattributed_runs))
        .with("unattributedConfirmed", Js::Num(a.unattributed_confirmed));
    line(out, o)
}

#[cfg(test)]
mod tests;
