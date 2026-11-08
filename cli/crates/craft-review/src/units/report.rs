//! What a report says of unit mode: why it was not in effect for a profile (`unitNoticeSection`),
//! what it ran for each one it was, and what its coordinator set aside (`seamSetAsideSection`).

use super::{UnitTrack, Units, seam};

/// What a run that asked for unit mode leaves out of the engine's, by construction.
pub const NOT_RUN: &str = "unit mode's choice among batch partitions by cost estimate (its batches are cut at one volume budget of 1500 lines) and the live coordinator a confined lens waits on mid-round (its questions reach the coordinator after the round instead)";

/// One unit track's line: its slices, its contract lenses and its coordinator.
fn line(t: &UnitTrack) -> String {
    let slices: Vec<String> = t
        .slices
        .iter()
        .map(|s| format!("`{}` ({} file(s))", s.key, s.files.len()))
        .collect();
    let coordinator = match &t.seam {
        Some(s) => format!(
            "the coordinator answered {} question(s) of {} asked, reported {} seam finding(s), and of the dependent findings confirmed {}, dropped {}, converted {}",
            s.answered,
            t.questions.len(),
            s.findings,
            s.dispositions.confirm,
            s.dispositions.drop,
            s.dispositions.convert
        ),
        None => "the coordinator did not answer".into(),
    };
    format!(
        "- {}: {} slice(s): {}; a contract lens on each of {}; {coordinator}.",
        t.profile,
        t.slices.len(),
        slices.join(" · "),
        t.units.join(", ")
    )
}

/// The report's unit-mode section, empty when the run did not ask for it or ended before any lens.
#[must_use]
pub fn section(units: &Units) -> String {
    if units.tracks.is_empty() && units.notices.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Unit mode (unitScope)\n\n");
    for n in &units.notices {
        out.push_str(&format!("⚠️ {n}\n"));
    }
    for t in &units.tracks {
        out.push_str(&line(t));
        out.push('\n');
    }
    out.push_str(&seam::section(
        units
            .tracks
            .iter()
            .filter_map(|t| t.seam.as_ref())
            .flat_map(|s| s.set_aside.iter()),
    ));
    out
}
