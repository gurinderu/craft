//! What the runs did not do: the verifications deliberately not bought, the harm cap, the files no
//! language profile covered, and the craft agents not registered — each highest first.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::Retro;

use super::super::{line, num, table};
use super::{count, ranked};

/// The most of a ranking the text shows.
const TOP: usize = 20;

pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let s = &r.signals;
    line(
        out,
        Obj::new()
            .with("section", Js::str("signals"))
            .with("revokedRuns", count(s.revoked_runs))
            .with("harmCapRuns", count(s.harm_runs))
            .with("harmCapLowered", Js::Num(s.harm_lowered))
            .with("uncoveredRuns", count(s.uncovered_runs)),
    )?;
    let each = |out: &mut dyn Write, section: &str, key: &str, map| -> io::Result<()> {
        for (k, n) in ranked(map) {
            let o = Obj::new()
                .with("section", Js::str(section))
                .with(key, Js::str(k))
                .with("runs", count(*n));
            line(out, o)?;
        }
        Ok(())
    };
    each(out, "saved", "what", &s.saved)?;
    each(out, "uncovered", "file", &s.uncovered)?;
    each(out, "agentUnavailable", "agent", &s.unavailable)?;
    let mut fallbacks: Vec<_> = s.fallbacks.iter().collect();
    fallbacks.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then_with(|| super::utf16(a.0, b.0)));
    for (agent, (dispatches, runs)) in fallbacks {
        let o = Obj::new()
            .with("section", Js::str("agentFallback"))
            .with("agent", Js::str(agent))
            .with("dispatches", Js::Num(*dispatches))
            .with("runs", count(*runs));
        line(out, o)?;
    }
    Ok(())
}

fn ranking(out: &mut dyn Write, rows: &[Vec<String>]) -> io::Result<()> {
    if rows.is_empty() {
        return writeln!(out, "none");
    }
    table(out, rows)
}

pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let s = &r.signals;
    let rows = |map| -> Vec<Vec<String>> {
        ranked(map)
            .into_iter()
            .take(TOP)
            .map(|(k, n)| vec![n.to_string(), k.clone()])
            .collect()
    };
    writeln!(out, "\nSaved (verifications deliberately not bought)")?;
    ranking(out, &rows(&s.saved))?;
    if s.revoked_runs > 0 {
        writeln!(
            out,
            "{} run(s) where the premise did not hold: the verdict those skips were justified by never arrived",
            s.revoked_runs
        )?;
    }
    writeln!(
        out,
        "\nHarm cap: {} finding(s) lowered to their harm's ceiling over {} run(s) that record it",
        num(s.harm_lowered),
        s.harm_runs
    )?;
    writeln!(
        out,
        "\nNot reviewed (files no language profile covered, {} run(s))",
        s.uncovered_runs
    )?;
    ranking(out, &rows(&s.uncovered))?;
    writeln!(
        out,
        "\nAgent unavailable (not registered; work on the generic subagent)"
    )?;
    let mut cells: Vec<Vec<String>> = ranked(&s.unavailable)
        .into_iter()
        .map(|(a, n)| vec![format!("{n} run(s)"), format!("{a} not registered")])
        .collect();
    let mut fallbacks: Vec<_> = s.fallbacks.iter().collect();
    fallbacks.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then_with(|| super::utf16(a.0, b.0)));
    cells.extend(fallbacks.into_iter().map(|(a, (d, n))| {
        vec![
            format!("{} dispatch(es) in {n} run(s)", num(*d)),
            format!("{a} answered by the generic subagent"),
        ]
    }));
    ranking(out, &cells)
}
