//! What the report says of publishing on the PR: the doubtful findings, numbered as the run record
//! keeps them (`doubtfulSection` in `lib/finding-sort.mjs`), and what came of posting the defects.

use serde_json::Value;

use super::sort::{line, text};
use super::{Posted, RunState};

/// The heading of the doubtful findings in the report.
const DOUBTFUL_HEADING: &str = "## Doubtful — for the reviewer, not posted";

/// The report's sections: the doubtful findings and what was posted, '' when not asked.
pub(crate) fn section(run: &RunState) -> String {
    let Some(s) = &run.publish.sorting else {
        return String::new();
    };
    let doubtful = doubtful_section(&s.doubtful, &s.note);
    let posted = match &run.publish.posted {
        None => format!("- {} defect(s) to post; not posted yet", s.defects.len()),
        Some(p) => posted_line(p),
    };
    format!("{doubtful}\n\n## PR comments\n{posted}\n")
}

/// One line of what came of posting.
pub(super) fn posted_line(p: &Posted) -> String {
    let no_file = if p.no_file == 0 {
        String::new()
    } else {
        format!(
            " · {} defect(s) name no file and could not be posted",
            p.no_file
        )
    };
    if p.requested == 0 {
        return format!("- {}{no_file}", p.reason);
    }
    if p.posted + p.already + p.failed == 0 {
        return format!(
            "- ⚠️ nothing was posted ({} defect(s)): {}{no_file}",
            p.requested, p.reason
        );
    }
    let warn = if p.error.is_empty() && p.posted + p.already == p.requested {
        ""
    } else {
        "⚠️ "
    };
    let failed = if p.error.is_empty() {
        String::new()
    } else {
        format!(" · gh failed: {}", p.error)
    };
    let to_file = if p.to_file == 0 {
        String::new()
    } else {
        format!(
            " · {} posted on its file, GitHub refusing its line as outside the PR's diff",
            p.to_file
        )
    };
    format!(
        "- {warn}posted {} of {} defect(s) · {} already on the PR (craft-finding marker), not posted again · {}{to_file}{failed}{no_file}",
        p.posted, p.requested, p.already, p.reason
    )
}

/// The report section of the doubtful findings, numbered as the run record keeps them
/// (`doubtfulSection`); '' when none and nothing to say. `note`: why the outside-the-diff sign was
/// not applied, or ''.
fn doubtful_section(doubtful: &[(Value, Vec<String>)], note: &str) -> String {
    let warn = if note.is_empty() {
        String::new()
    } else {
        format!(" ⚠️ {note}")
    };
    if doubtful.is_empty() {
        return if note.is_empty() {
            String::new()
        } else {
            format!("\n\n{DOUBTFUL_HEADING}\n- none ·{warn}\n")
        };
    }
    let lines: Vec<String> = doubtful
        .iter()
        .enumerate()
        .map(|(i, (f, reasons))| {
            let file = text(f, "file");
            format!(
                "{}. {} · `{}:{}` · {} · doubtful: {}",
                i + 1,
                text(f, "severity"),
                if file.is_empty() { "?" } else { &file },
                line(f),
                text(f, "title"),
                reasons.join("; ")
            )
        })
        .collect();
    format!(
        "\n\n{DOUBTFUL_HEADING}\nNot posted on the PR: each waits for the reviewer's choice — ask the author (a question comment), post it as a defect, or do not post it. The sorting changes nothing in the verdict.{warn}\n{}\n",
        lines.join("\n")
    )
}
