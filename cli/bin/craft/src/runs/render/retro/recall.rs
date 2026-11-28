//! What the runs recalled, the findings that went against a memory record, and how the doubtful
//! findings held back from a PR ended.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::Retro;
use craft_store::retro::contradictions::Tally;

use super::super::{line, num};
use super::{count, ranked};

mod memory;

const CHAINS: [&str; 2] = ["js", "cli"];

fn chain_obj(chain: &str, t: &Tally) -> Obj {
    Obj::new()
        .with("section", Js::str("contradictions"))
        .with("chain", Js::str(chain))
        .with("runs", count(t.runs))
        .with("count", Js::Num(t.count))
        .with("doubtSignsAlone", Js::Num(t.doubt_signs_alone))
        .with("toPr", count(t.to_pr))
        .with("noPosting", count(t.no_posting))
        .with("fixed", count(t.fixed))
        .with("open", count(t.open))
        .with("setAside", count(t.set_aside))
        .with("noLaterRound", count(t.no_later_round))
        .with("unknown", count(t.unknown))
}

pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let m = &r.memory;
    let map = |m| {
        let mut o = Obj::new();
        for (k, n) in ranked(m) {
            o.set(k, count(*n));
        }
        Js::Obj(o)
    };
    let o = Obj::new()
        .with("section", Js::str("memory"))
        .with("runs", count(m.runs))
        .with("carrying", count(m.carrying))
        .with("recalled", count(m.recalled))
        .with("none", count(m.none))
        .with("passedOnly", count(m.passed_only))
        .with("nested", count(m.nested))
        .with("records", Js::Num(m.records))
        .with("questions", Js::Num(m.questions))
        .with("rules", Js::Num(m.rules))
        .with("externals", Js::Num(m.externals))
        .with("covered", Js::Num(m.covered))
        .with("notRead", count(m.not_read))
        .with("partlyRead", count(m.partly_read))
        .with("launcherDegraded", count(m.launcher_degraded))
        .with("byBackend", map(&m.by_backend))
        .with("noneWhy", map(&m.none_why));
    line(out, o)?;
    for (chain, t) in CHAINS.iter().zip(&r.chains) {
        line(out, chain_obj(chain, t))?;
    }
    let s = &r.sorting;
    let o = Obj::new()
        .with("section", Js::str("sorting"))
        .with("runs", count(s.runs))
        .with("posted", Js::Num(s.posted))
        .with("doubtful", Js::Num(s.doubtful))
        .with("defect", count(s.defect))
        .with("question", count(s.question))
        .with("dropped", count(s.dropped))
        .with("undecided", Js::Num(s.undecided()));
    line(out, o)
}

pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    memory::text(out, r)?;
    writeln!(
        out,
        "\nMemory contradictions (findings against an active memory record)"
    )?;
    for (chain, t) in ["JS engines", "CLI"].iter().zip(&r.chains) {
        if t.runs == 0 {
            writeln!(out, "{chain}: not measured")?;
            continue;
        }
        writeln!(
            out,
            "{chain}: {} finding(s) in {} run(s) · {} the doubt signs alone would have sent · {} sent to the PR · {} not posted by their engine · later rounds: {} fixed, {} open, {} set aside, {} no later round, {} unknown",
            num(t.count),
            t.runs,
            num(t.doubt_signs_alone),
            t.to_pr,
            t.no_posting,
            t.fixed,
            t.open,
            t.set_aside,
            t.no_later_round,
            t.unknown
        )?;
    }
    let s = &r.sorting;
    writeln!(out, "\nSorting (doubtful findings held back from the PR)")?;
    if s.runs == 0 {
        return writeln!(out, "not measured: no run carries `sorting`");
    }
    let pct = |n| {
        s.percent(n)
            .map_or_else(String::new, |p| format!(" ({}%)", num(p)))
    };
    writeln!(
        out,
        "{} run(s) · {} posted as defects at once · {} held back · of those {} posted as defect{} · {} asked the author{} · {} not posted{} · {} undecided",
        s.runs,
        num(s.posted),
        num(s.doubtful),
        s.defect,
        pct(s.defect),
        s.question,
        pct(s.question),
        s.dropped,
        pct(s.dropped),
        num(s.undecided())
    )
}
