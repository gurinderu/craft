//! The retro's runs by kind: per kind its runs, the minutes and agents of a run that recorded
//! them, and the cost of a run whose cost is usable, the others counted by why (realm @nick/craft,
//! node #658).

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::{Kind, Retro};

use super::super::{line, opt, table};

/// The runs without a usable cost, by why: `missing 3, partial 1`, or `-`.
fn unpriced(k: &Kind) -> String {
    let why: Vec<String> = k
        .unpriced
        .iter()
        .map(|(p, n)| format!("{} {n}", p.as_str()))
        .collect();
    if why.is_empty() {
        "-".to_owned()
    } else {
        why.join(", ")
    }
}

/// The kinds as a table, most runs first.
pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    writeln!(out, "\nKinds")?;
    let mut kinds: Vec<(&String, &Kind)> = r.kinds.iter().collect();
    kinds.sort_by(|a, b| b.1.runs.cmp(&a.1.runs).then(a.0.cmp(b.0)));
    let head = [
        "KIND",
        "RUNS",
        "MIN/RUN",
        "AGENTS/RUN",
        "PRICED",
        "COST/RUN",
        "UNPRICED",
    ];
    let mut cells = vec![head.map(String::from).to_vec()];
    cells.extend(kinds.iter().map(|(name, k)| {
        vec![
            (*name).clone(),
            k.runs.to_string(),
            opt(k.minutes_per_run()),
            opt(k.agents_per_run()),
            k.priced.to_string(),
            opt(k.cost_per_run()),
            unpriced(k),
        ]
    }));
    table(out, &cells)
}

/// The kinds as NDJSON lines, `section: "kind"`.
pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
    let n = |c: u64| Js::Num(c as f64);
    for (name, k) in &r.kinds {
        let mut why = Obj::new();
        for (p, c) in &k.unpriced {
            why.set(p.as_str(), n(*c));
        }
        let o = Obj::new()
            .with("section", Js::str("kind"))
            .with("kind", Js::str(name))
            .with("runs", n(k.runs))
            .with("timed", n(k.timed))
            .with(
                "minutesPerRun",
                k.minutes_per_run().map_or(Js::Null, Js::Num),
            )
            .with("counted", n(k.counted))
            .with("agentsPerRun", k.agents_per_run().map_or(Js::Null, Js::Num))
            .with("priced", n(k.priced))
            .with("cost", Js::Num(k.cost))
            .with("costPerRun", k.cost_per_run().map_or(Js::Null, Js::Num))
            .with("unpriced", Js::Obj(why));
        line(out, o)?;
    }
    Ok(())
}
