//! What the hooks say in Codex (realm @nick/craft, nodes #293, #292): it has neither the Skill nor
//! the Workflow tool, so it reads a skill's SKILL.md from the path its skill list gives, and runs
//! craft's review in the session through the craft binary (craft:codex-review, #499). Its prompt
//! text is the same for both English kinds.

use super::text::{
    CODEX_RE_REVIEW, MEMORY, READ, REPORT, REVIEWER, if_request, off, re_review_line, recall_line,
    reminder_line,
};

/// How Codex reviews: craft's review through the craft binary with its Codex backend, run in the
/// session; by hand when that command cannot run or fails (#499).
pub const CODEX_REVIEW: &str = "run craft:codex-review in this session, not in a subagent: read its SKILL.md and run the one command it gives (it drives craft's review through codex exec), then relay its verdict and findings; it is new and not yet observed in a real Codex session, so when that command cannot run here or fails, review the diff yourself: apply the checklist of craft:rust-review (Rust), craft:nix-review (Nix) or craft:sql-review (SQL), otherwise read the diff for defects, and report the findings by severity with file:line";

/// The start hook's cycle lines in Codex.
pub fn cycle() -> [String; 2] {
    [
        "craft: whichever declared role develops here runs its cycle with craft's skills, reading each one's SKILL.md (its path is listed among your skills): recall project memory (craft:memory) before the work; before a PR, a review, its findings worked with craft:addressing-findings.".to_owned(),
        format!("craft: {CODEX_REVIEW}."),
    ]
}

fn addressing() -> String {
    format!("read craft:addressing-findings' {READ}")
}

/// Every line of the prompt text after its first.
fn rest() -> Vec<String> {
    let mut report = REPORT.to_owned();
    if let Some(first) = report.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    vec![
        recall_line(
            &format!("read craft:memory's {READ} and"),
            "for findings work, right after reading the skill",
        ),
        re_review_line(CODEX_RE_REVIEW),
        format!("craft: record each finding you reject or defer with {MEMORY}."),
        format!(
            "craft: triage the findings here in this session, never in a subagent, whatever their number: Codex has no triage engine, so do the sift steps of craft:addressing-findings (\"Who triages\") yourself, then record each disposition and file the issues; only the fixes may go to a subagent: brief it with its file group of the plan, the verdicts and the records craft:memory recalls, and tell it: \"{report}.\" Re-decide and record each one it reports. A review stays in this session."
        ),
        off(),
    ]
}

/// The prompt hook's text: `other` for a prompt in another script.
pub fn prompt(other: bool) -> String {
    let first = if other {
        if_request(&addressing(), CODEX_REVIEW)
    } else {
        format!(
            "craft: before your first tool call on this request, read its craft skill's {READ}: review findings or PR comments → craft:addressing-findings; a review → {CODEX_REVIEW}. Reading the PRs with gh first does not replace it."
        )
    };
    let mut lines = vec![first];
    lines.extend(rest());
    lines.join("\n")
}

/// The one line a later prompt in another script hears.
pub fn reminder() -> String {
    reminder_line(
        &addressing(),
        "craft:codex-review in this session (if it cannot run or fails, review the diff yourself)",
        CODEX_RE_REVIEW,
    )
}

/// What a subagent hears.
pub fn subagent() -> String {
    [
        format!(
            "craft: if your brief is to work review findings or PR comments: triage is never yours (the main session triages): fix only the file group your brief gives, its verdicts as given: before your first tool call read craft:addressing-findings' {READ} for how to fix and verify, and {REPORT}; if your brief is to review: {REVIEWER}."
        ),
        off(),
    ]
    .join("\n")
}
