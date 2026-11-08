//! The gate as a report states it: per profile its status and what ran, the red checks, the tools
//! not installed and what was skipped — never silent, so "no gate line" cannot read as a clean one.

use super::{Gate, Status};

fn status(s: Status) -> &'static str {
    match s {
        Status::Pass => "pass",
        Status::Fail => "FAIL",
        Status::Unknown => "unknown",
    }
}

/// The report's gate section; empty when no profile of the run has a gate.
#[must_use]
pub fn section(gate: &Gate) -> String {
    if gate.tracks.is_empty() {
        return if gate.skipped.is_empty() {
            String::new()
        } else {
            format!("## Gate\n\nNot run: {}.\n\n", gate.skipped)
        };
    }
    let mut out = String::from("## Gate\n\n");
    for t in &gate.tracks {
        let ran = if t.provenance.is_empty() { "nothing ran" } else { &t.provenance };
        out.push_str(&format!("- **{}**: {} — {ran}\n", t.profile, status(t.status)));
        for c in &t.failed_checks {
            out.push_str(&format!("  - Failed: {c}\n"));
        }
        if !t.missing.is_empty() {
            out.push_str(&format!(
                "  - Not installed, skipped (the review went on without them): {}\n",
                t.missing.join(", ")
            ));
        }
        for n in &t.notes {
            out.push_str(&format!("  - {n}\n"));
        }
        if t.seeds > 0 {
            out.push_str(&format!("  - {} tool finding(s) seeded for the lenses and the verifiers\n", t.seeds));
        }
    }
    out.push('\n');
    out
}
