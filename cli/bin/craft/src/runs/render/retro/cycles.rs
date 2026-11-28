//! How the craft:develop cycles ended, and craft:review's light runs beside its full ones.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::Retro;
use craft_store::retro::depth::Population;

use super::super::{line, num, opt};
use super::count;

const CHAINS: [&str; 2] = ["js", "cli"];
const DEPTHS: [&str; 2] = ["light", "full"];

pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let d = &r.develop;
    let o = Obj::new()
        .with("section", Js::str("develop"))
        .with("cycles", count(d.cycles))
        .with("unreadable", count(d.unreadable))
        .with("converged", count(d.converged))
        .with("capped", count(d.capped))
        .with("noVerdict", count(d.no_verdict))
        .with("light", count(d.light))
        .with("full", count(d.full))
        .with("roundsPerCycle", Js::Num(d.rounds_per_cycle().0))
        .with("roundsToConverge", Js::Num(d.rounds_per_cycle().1))
        .with(
            "cyclesByRound",
            Js::Arr(d.by_round.iter().map(|(n, _)| count(*n)).collect()),
        )
        .with(
            "mediumPlusByRound",
            Js::Arr(d.by_round.iter().map(|(_, m)| Js::Num(*m)).collect()),
        )
        .with("fullReviews", count(d.full_reviews))
        .with("fullReopened", count(d.full_reopened))
        .with("fullNoVerdict", count(d.full_no_verdict))
        .with("clean", count(d.clean()));
    line(out, o)?;
    for (chain, pair) in CHAINS.iter().zip(&r.depth) {
        for (depth, p) in DEPTHS.iter().zip(pair) {
            let [agents, minutes, confirmed] = p.per_run();
            let o = Obj::new()
                .with("section", Js::str("depth"))
                .with("chain", Js::str(*chain))
                .with("depth", Js::str(*depth))
                .with("runs", count(p.runs))
                .with("agentsPerRun", agents.map_or(Js::Null, Js::Num))
                .with("minutesPerRun", minutes.map_or(Js::Null, Js::Num))
                .with("confirmedPerRun", confirmed.map_or(Js::Null, Js::Num));
            line(out, o)?;
        }
    }
    Ok(())
}

fn population(out: &mut dyn Write, depth: &str, p: &Population) -> io::Result<()> {
    let [agents, minutes, confirmed] = p.per_run();
    writeln!(
        out,
        "{depth}: {} run(s), agents/run {}, wall min/run {}, confirmed/run {}",
        p.runs,
        opt(agents),
        opt(minutes),
        opt(confirmed)
    )
}

pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let d = &r.develop;
    writeln!(out, "\nDevelop (craft:develop cycles)")?;
    if d.cycles == 0 {
        writeln!(out, "not measured: no develop cycle record")?;
    } else {
        writeln!(
            out,
            "{} cycle(s) · {} converged · {} capped · {} stopped without a verdict · light {} / full {} · {} round(s) per cycle, {} to converge",
            d.cycles,
            d.converged,
            d.capped,
            d.no_verdict,
            d.light,
            d.full,
            num(d.rounds_per_cycle().0),
            num(d.rounds_per_cycle().1)
        )?;
        let rounds: Vec<String> = d
            .by_round
            .iter()
            .enumerate()
            .map(|(i, (n, m))| format!("r{} {} in {n}", i + 1, num(*m)))
            .collect();
        writeln!(out, "open Medium+ after each round: {}", rounds.join(" · "))?;
        if d.full_reviews == 0 {
            writeln!(
                out,
                "full review: none ran (no cycle converged, or none recorded one)"
            )?;
        } else {
            writeln!(
                out,
                "full review: {} run(s) · {} reopened the loop · {} without a verdict · {} clean",
                d.full_reviews,
                d.full_reopened,
                d.full_no_verdict,
                d.clean()
            )?;
        }
    }
    if d.unreadable > 0 {
        writeln!(
            out,
            "{} develop record(s) unreadable, not counted",
            d.unreadable
        )?;
    }
    for (chain, pair) in ["JS engine", "CLI"].iter().zip(&r.depth) {
        writeln!(
            out,
            "\nDepth: craft:review ({chain}), light runs apart from the full-plan figures"
        )?;
        let [light, full] = pair;
        population(out, "full", full)?;
        population(out, "light", light)?;
    }
    Ok(())
}
