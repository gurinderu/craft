//! What the work hook says in OpenCode (realm @nick/craft, node #288): the same shape as the
//! Claude Code texts per request kind, in OpenCode's words. It has no Workflow tool and no
//! craft:develop; skills load with its skill tool by directory name, and its review is the
//! rust-review skill with the review agents it dispatches, or the plugin's rust-audit tool.

use super::kind::Kind;
use super::text::{
    FOR_FINDINGS, REVIEWER, WHY_FINDINGS, delegate_both, delegate_fixes, fix_brief, if_request,
    launcher, off, re_review_line, recall_line, reminder_line, review_brief, subagent_memory,
    subagent_work,
};

// The OpenCode installer links skills by directory name: the memory skill is `memory`.
const MEMORY: &str = "the memory skill (record-decision, record-rule or record-question), and check the `memory backend:` line it prints";
const RECALL: &str = "load the memory skill with the skill tool and";
// No Workflow tool here: the re-review is the session's own pass over the fix commits, or for
// Rust the review this delivery ships.
const RE_REVIEW: &str = "here in this session over git diff <that commit>..HEAD: for Rust code the rust-review skill or the rust-audit tool, otherwise your own review pass";
// No sift engine here: the session sifts itself; the plugin's triage-findings tool only validates.
const TRIAGE: &str = "triage the findings here in this session, never in a subagent, whatever their number: OpenCode has no sift engine, so do the sift steps of addressing-findings (\"Who triages\") yourself (recall; set aside what a recorded decision, deferred question or project rule answers; raise again each Critical/High or scope-changed one; a finding the PR did not introduce → an issue), then validate the rest inline or with the triage-findings tool, which validates and plans but does not sift; record each disposition and file the issues yourself";

fn memory_launcher() -> String {
    launcher("the memory skill", MEMORY)
}

fn findings_brief() -> String {
    fix_brief("the addressing-findings skill (skill tool)")
}

fn findings() -> String {
    [
        "craft: before your first tool call on this request, make one call: load the addressing-findings skill with the skill tool. Reading the PRs with gh first does not replace it.".to_owned(),
        recall_line(RECALL, "right after loading it"),
        re_review_line(RE_REVIEW),
        WHY_FINDINGS.to_owned(),
        memory_launcher(),
        format!("craft: {TRIAGE}."),
        delegate_fixes(&findings_brief(), "once triage is done and its dispositions are recorded"),
        off(),
    ]
    .join("\n")
}

fn review() -> String {
    [
        "craft: before your first tool call on this request, make one call: for Rust code, load the rust-review skill with the skill tool, or call the rust-audit tool (the /rust-audit command) for a whole crate. Reading the PRs with gh first does not replace it.".to_owned(),
        "craft: why: rust-review runs the cargo gate and a severity-tiered checklist to an Approve/Warning/Block verdict and dispatches craft's review agents with a crafted brief; the rust-audit tool fans those agents out over the crate into one severity-ranked report.".to_owned(),
        memory_launcher(),
        format!(
            "craft: delegating a review to a reviewer agent is fine: paste this line verbatim into its brief: {} Fixing the findings stays here, with addressing-findings.",
            review_brief()
        ),
        off(),
    ]
    .join("\n")
}

fn other_language() -> String {
    [
        if_request(
            "load the addressing-findings skill with the skill tool",
            "for Rust code load the rust-review skill with the skill tool, or call the rust-audit tool (the /rust-audit command) for a whole crate",
        ),
        recall_line(RECALL, FOR_FINDINGS),
        re_review_line(RE_REVIEW),
        memory_launcher(),
        delegate_both(TRIAGE, &findings_brief()),
        off(),
    ]
    .join("\n")
}

/// The text for a main session's request of `kind`.
pub fn prompt(kind: Kind) -> String {
    match kind {
        Kind::Findings => findings(),
        Kind::Review => review(),
        Kind::OtherLanguage => other_language(),
    }
}

/// The one line a later request in another script hears.
pub fn reminder() -> String {
    reminder_line(
        "load the addressing-findings skill",
        "rust-review or the rust-audit tool",
        "the rust-review skill for Rust code, otherwise your own review pass over them in this session",
    )
}

/// What a subagent session hears on its first message.
pub fn subagent() -> String {
    [
        subagent_work(
            "load addressing-findings with the skill tool",
            "the main session triages, doing the sift itself",
        ),
        subagent_memory(),
        format!("craft: if your brief is only to review: {REVIEWER}."),
        "craft: the re-review loop belongs to the main session: report back and leave it there."
            .to_owned(),
        off(),
    ]
    .join("\n")
}
