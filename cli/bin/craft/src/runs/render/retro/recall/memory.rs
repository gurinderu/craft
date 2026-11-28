//! What the runs recalled, as text.

use std::io::{self, Write};

use craft_store::retro::Retro;

use super::super::super::num;
use super::super::ranked;

/// The most backends and reasons the text names.
const TOP: usize = 10;

pub(super) fn text(out: &mut dyn Write, r: &Retro) -> io::Result<()> {
    let m = &r.memory;
    writeln!(out, "\nMemory (what the review recalled before judging)")?;
    if m.carrying == 0 {
        return writeln!(
            out,
            "not measured: none of the {} run(s) carried `memory`",
            m.runs
        );
    }
    writeln!(
        out,
        "{} run(s) carry it ({} without) · {} recalled · {} none ({} applied the launcher's records) · {} nested under an audit · {} record(s), {} open question(s), {} rule(s), {} external system(s) · {} finding(s) covered by a rule",
        m.carrying,
        m.runs - m.carrying,
        m.recalled,
        m.none,
        m.passed_only,
        m.nested,
        num(m.records),
        num(m.questions),
        num(m.rules),
        num(m.externals),
        num(m.covered)
    )?;
    if m.not_read + m.partly_read + m.launcher_degraded > 0 {
        writeln!(
            out,
            "degraded: {} not read · {} partly read · {} nested run(s) handed a launcher's degraded recall",
            m.not_read, m.partly_read, m.launcher_degraded
        )?;
    }
    for (b, n) in ranked(&m.by_backend).into_iter().take(TOP) {
        writeln!(out, "{n}× from {b}")?;
    }
    for (why, n) in ranked(&m.none_why).into_iter().take(TOP) {
        writeln!(out, "{n}× none — {why}")?;
    }
    Ok(())
}
