//! The report's account of the extra lenses, as `extraLensSection` in
//! `lib/review-extra-lenses.mjs` words it: which ran, how they were chosen, and each gap.

use super::{DISCOVERY_SKIPPED, ExitNote, Extra, Failed, How};
use crate::state::RunState;

fn gap_mark(x: &Failed) -> String {
    format!(
        "- \u{26a0}\u{fe0f} coverage gap: {} -- {}; its review did not happen.",
        x.agent, x.why
    )
}

fn soft_mark(x: &Failed) -> String {
    format!(
        "- {} could not run: {} (discovered, not named, so no coverage gap).",
        x.agent, x.why
    )
}

fn ran_line(ran: &[String], rubric: &str) -> String {
    if ran.is_empty() {
        return "Ran: none.".into();
    }
    let verified = if rubric.is_empty() {
        String::new()
    } else {
        format!(
            " Their findings were verified under the {rubric} profile's rubric, whatever file they cite."
        )
    };
    format!("Ran: {}.{verified}", ran.join(", "))
}

fn exit_section(e: &Extra, exit: &ExitNote) -> String {
    let mut lines: Vec<String> = if e.how == How::Discovered {
        vec![format!("Discovery did not run ({}).", exit.reason)]
    } else {
        let ran = if exit.needed {
            "Ran: none.".to_owned()
        } else {
            format!(
                "Ran: none. Not needed ({}): there was nothing for them to review.",
                exit.reason
            )
        };
        vec!["Chosen: named by the caller (extraLenses).".into(), ran]
    };
    lines.extend(e.failed.iter().map(gap_mark));
    format!("\n\n## Extra lenses\n{}\n", lines.join("\n"))
}

fn none_section(discovery: &str) -> String {
    let head = if discovery == DISCOVERY_SKIPPED {
        "Discovery skipped: repo is not this session's project, so its agents were not run on it"
            .to_owned()
    } else if discovery.is_empty() {
        "No repo reviewer found: none of the session project's agents describes itself as reviewing"
            .to_owned()
    } else {
        format!("No repo reviewer found: {discovery}")
    };
    format!(
        "\n\n## Extra lenses\n{head} -- only the engine's own lenses ran. Name one with `extraLenses: [\"<agent>\"]`.\n"
    )
}

/// The section, once the lenses were reached; empty when they were off or never reached.
#[must_use]
pub fn section(run: &RunState) -> String {
    let e = &run.extra;
    if e.how == How::Off || !e.reached {
        return String::new();
    }
    if let Some(exit) = &e.exit {
        return exit_section(e, exit);
    }
    if e.how == How::Discovered && e.ran.is_empty() && e.failed.is_empty() {
        return none_section(&e.discovery);
    }
    let chosen = if e.how == How::Named {
        "named by the caller (extraLenses)"
    } else {
        "discovered among the session project's agents"
    };
    let rubric = if e.ran.is_empty() {
        ""
    } else {
        run.tracks.first().map_or("", |t| t.profile.as_str())
    };
    let mark = if e.how == How::Named {
        gap_mark
    } else {
        soft_mark
    };
    let mut lines = vec![format!("Chosen: {chosen}."), ran_line(&e.ran, rubric)];
    lines.extend(e.failed.iter().map(mark));
    format!("\n\n## Extra lenses\n{}\n", lines.join("\n"))
}
