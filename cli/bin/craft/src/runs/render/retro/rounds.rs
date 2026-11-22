//! The retro's lens rounds: one line per round, what it raised, what of that it raised first and
//! the dedup kept, and what of that verification confirmed. Nothing when no record carried them.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::Retro;

use super::super::{line, num};

/// The rounds as text, under their own heading, when any record carried a round's yield.
pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    if r.rounds.is_empty() {
        return Ok(());
    }
    writeln!(out, "\nLens rounds (raw → new unique → confirmed)")?;
    for (round, y) in &r.rounds {
        writeln!(
            out,
            "round {round}: {} → {} → {} over {} run(s)",
            num(y.raw),
            num(y.new_unique),
            num(y.confirmed),
            y.runs
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
            .with("confirmed", Js::Num(y.confirmed));
        line(out, o)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use craft_store::retro::{Retro, Round};

    use super::{json, text};

    fn printed(r: &Retro, f: fn(&mut dyn std::io::Write, &Retro) -> std::io::Result<()>) -> String {
        let mut out = Vec::new();
        f(&mut out, r).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn each_round_prints_raw_new_unique_and_confirmed() {
        let mut r = Retro::default();
        let one = Round {
            runs: 2,
            raw: 16.0,
            new_unique: 6.0,
            confirmed: 3.0,
        };
        r.rounds.insert(1, one);
        r.rounds.insert(
            2,
            Round {
                runs: 2,
                raw: 14.0,
                new_unique: 1.0,
                confirmed: 0.0,
            },
        );
        assert_eq!(
            printed(&r, text),
            "\nLens rounds (raw → new unique → confirmed)\nround 1: 16 → 6 → 3 over 2 run(s)\nround 2: 14 → 1 → 0 over 2 run(s)\n"
        );
        let first = printed(&r, json).lines().next().unwrap().to_owned();
        let v: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"section": "lensRound", "round": 1, "runs": 2, "raw": 16, "newUnique": 6, "confirmed": 3})
        );
    }

    #[test]
    fn a_retro_with_no_round_yield_prints_nothing_for_it() {
        let r = Retro::default();
        assert_eq!(
            (printed(&r, text), printed(&r, json)),
            (String::new(), String::new())
        );
    }
}
