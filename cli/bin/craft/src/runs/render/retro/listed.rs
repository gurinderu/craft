//! The runs that did not finish, listed apart from every sum: when, which workflow, why, and what
//! the run had spent.

use std::io::{self, Write};

use craft_store::js::{Js, Obj, number_text};
use craft_store::retro::Retro;

use super::super::line;
use super::count;

/// The chain of a review run, `None` for another workflow.
fn chain(r: &Obj) -> Option<&'static str> {
    craft_store::retro::depth::is_review(r).then(|| {
        if craft_store::retro::is_cli(r) {
            "cli"
        } else {
            "js"
        }
    })
}

fn stats(r: &Obj) -> Option<&Obj> {
    r.get("runtimeStats").and_then(Js::as_obj)
}

fn reason(r: &Obj) -> Js {
    r.get("partialReason")
        .filter(|v| v.truthy())
        .cloned()
        .unwrap_or_else(|| Js::str("incomplete"))
}

pub fn json(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let o = Obj::new()
        .with("section", Js::str("unfinishedListed"))
        .with("listed", count(r.listed.len() as u64))
        .with("unattributed", count(r.listed_unattributed))
        .with("twins", count(r.listed_twins));
    line(out, o)?;
    for p in &r.listed {
        let stat = |k: &str| stats(p).and_then(|s| s.get(k)).cloned().unwrap_or(Js::Null);
        let o = Obj::new()
            .with("section", Js::str("unfinishedRun"))
            .with("ts", p.get("ts").cloned().unwrap_or(Js::Null))
            .with("name", p.get("name").cloned().unwrap_or(Js::Null))
            .with("chain", chain(p).map_or(Js::Null, Js::str))
            .with("reason", reason(p))
            .with("agents", stat("agents"))
            .with("wallClockMinutes", stat("wallClockMinutes"))
            .with("longestStallSeconds", stat("longestStallSeconds"));
        line(out, o)?;
    }
    Ok(())
}

/// What a run spent before it died: its agents, minutes and a stall over ten minutes.
fn spent(p: &Obj) -> String {
    let Some(s) = stats(p) else {
        return String::new();
    };
    let text = |k: &str| {
        s.get(k).map_or_else(
            || "undefined".to_owned(),
            |v| v.to_js_text().to_utf8_lossy(),
        )
    };
    let stall = s
        .get("longestStallSeconds")
        .and_then(Js::as_num)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0);
    let stalled = if stall > 600.0 {
        format!(
            ", longest single-agent stall {}min",
            number_text(craft_store::retro::plan::js_round(stall / 60.0))
        )
    } else {
        String::new()
    };
    format!(
        " · {} agent(s), {}min wall{stalled}",
        text("agents"),
        text("wallClockMinutes")
    )
}

pub fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    if r.listed.is_empty() && r.listed_unattributed == 0 && r.listed_twins == 0 {
        return Ok(());
    }
    writeln!(
        out,
        "\nRuns that did not finish ({}; outside every sum above)",
        r.listed.len()
    )?;
    if r.listed_unattributed > 0 {
        writeln!(
            out,
            "{} could not be attributed to this slice (no craft version on the record or its checkpoints), not listed",
            r.listed_unattributed
        )?;
    }
    if r.listed_twins > 0 {
        writeln!(
            out,
            "{} rebuilt record(s) hidden: the same run later wrote its complete record",
            r.listed_twins
        )?;
    }
    for p in &r.listed {
        let field = |k: &str| {
            p.get(k).map_or_else(
                || "undefined".to_owned(),
                |v| v.to_js_text().to_utf8_lossy(),
            )
        };
        let engine = match chain(p) {
            Some("cli") => " (CLI)",
            Some(_) => " (JS engine)",
            None => "",
        };
        let why = reason(p).to_js_text().to_utf8_lossy();
        writeln!(
            out,
            "{} {}{engine} — {why}{}",
            field("ts"),
            field("name"),
            spent(p)
        )?;
    }
    Ok(())
}
