//! What the hooks say in Claude Code, per request kind (realm @nick/craft, nodes #275, #288, #293):
//! Claude Code loads a skill with its Skill tool and runs craft's review engines with its Workflow
//! tool, which only the main session has (#262). Subagents lack the memory tools: the launcher
//! puts the recalled records into each brief. Triage is the main session's, never a subagent's
//! (skills/addressing-findings, "Who triages"). Each text gives one call to make first, one reason
//! the skill beats doing it by hand, and lets delegation stand with a line to paste into the brief.
//! The phrases Codex's and OpenCode's texts share are here too (`super::text_codex`,
//! `super::text_opencode`).

use super::declared::SWITCH_ENV;
use super::kind::Kind;

pub fn off() -> String {
    format!(
        "craft: the repo's own roles and rules still win; to silence this, set {SWITCH_ENV}=0 or add `craft-role-hook: off` to AGENTS.md or CLAUDE.md."
    )
}
pub const MEMORY: &str = "craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints";
pub const READ: &str = "SKILL.md (its path is listed among your skills)";
pub const REPORT: &str = "report each planned fix you find wrong, with its reason, in your result; never re-triage and never write memory: your launcher decides and records it";
pub const REVIEWER: &str = "report findings only, change no code and record nothing";
pub const ADDRESS: &str = "Skill(\"craft:addressing-findings\")";
pub const WHY_FINDINGS: &str = "craft: why: it checks each finding against the code for a verdict, keeps every rejection on record so later reviews know it, drafts each reply for its own thread, and re-reviews until green; that re-review loop stays with this main session even when subagents fix.";
pub const FOR_FINDINGS: &str = "for findings work, right after loading the skill";
const LIGHT: &str = "a light re-review of the fix commits only (base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first)";
const ROUTES: &str = "on any language (Rust, Nix and SQL under their profiles, other source under its general lenses, in one run)";
const TRIAGE: &str = "triage the findings here in the main session, whatever their number: launch the craft:triage-findings workflow (Workflow tool) with report = the findings written to a file in the session's temporary directory whenever they live in a review report, and pr = the PR number whenever there is a PR (it reads the PR's threads itself), at least one of the two, and prBase = git merge-base origin/<trunk> <reviewed head> together with base = the reviewed head's SHA, only when the reviewed head is a branch diverging from trunk (that merge-base differs from the head; on trunk or with no branch leave prBase out, and the findings claimed not this PR's come to you), even when the recall above failed (it recalls for itself); never hand triage to a subagent, which has no Workflow tool; right after it returns, record each disposition and file its issues yourself";
pub const CODEX_RE_REVIEW: &str = "craft:codex-review with --base <that commit> --fresh --delta --full-every 0 --depth light --extra-lenses off in this session (if it cannot run or fails, your own pass over git diff <that commit>..HEAD)";

pub fn review_brief() -> String {
    format!("\"Review only: {REVIEWER}; return each finding with its severity and file:line.\"")
}
fn re_review() -> String {
    format!(
        "here in the main session with the craft:review workflow {{ base: <that commit>, fresh: true, delta: true, fullEvery: 0, depth: 'light', extraLenses: [] }} {ROUTES}"
    )
}
/// The main session holds the memory: `skill` names the memory skill, `record` how to record.
pub fn launcher(skill: &str, record: &str) -> String {
    format!(
        "craft: subagents lack the memory tools, so you hold the memory: put the records {skill} recalls, verbatim with their ids, into each brief, and record every triage disposition (each finding rejected or deferred) yourself, right after triage, never through a subagent, with {record}."
    )
}
/// The brief a fixer gets with its file group; `load` names how it loads addressing-findings.
pub fn fix_brief(load: &str) -> String {
    format!(
        "\"Fix only: patch this file group of the triage plan, its verdicts as given; before your first tool call, load {load} for how to fix and verify (its steps 5 and 6); {REPORT}.\""
    )
}
fn findings_brief() -> String {
    fix_brief("the craft:addressing-findings skill (Skill tool)")
}
/// The line that hands the fixes, and only them, to subagents.
pub fn delegate_fixes(brief: &str, after: &str) -> String {
    format!(
        "craft: delegating the fixes is fine: {after}, paste this line verbatim into each fixer's brief with its file group: {brief} Triage, memory writes, issues and the re-review stay here in the main session."
    )
}
/// Triage here, then delegation of either kind, in one line.
pub fn delegate_both(triage: &str, brief: &str) -> String {
    format!(
        "craft: for findings, {triage}; then only the fixes may be delegated: paste this line verbatim into each fixer's brief with its file group: {brief} For a reviewer agent, paste: {} Triage, memory writes, issues and the re-review stay here.",
        review_brief()
    )
}
/// A subagent's findings line: `load` is how it loads addressing-findings, `triager` who triages.
pub fn subagent_work(load: &str, triager: &str) -> String {
    format!(
        "craft: if your brief is to work findings (triaging PR comments, drafting or posting replies to review threads and fixing per review comments all count): triage is never yours: {triager}; a brief that asks you to triage: report that back and stop. For a file group of a triage plan: before your first tool call, {load} and fix the group with it, its verdicts as given; replies are the main session's, posted only on the user's OK."
    )
}
pub fn subagent_memory() -> String {
    format!(
        "craft: you lack the memory tools and never write memory: the records your launcher recalled are in your brief; {REPORT}."
    )
}
pub fn recall_line(recall: &str, lead: &str) -> String {
    format!(
        "craft: {lead}, before triage (its step 0): {recall} recall(<finding keywords>, <path>) for every path the findings touch; a finding a recalled decision answers is triaged with it cited."
    )
}
pub fn re_review_line(how: &str) -> String {
    format!(
        "craft: after the fixes are in (every fixer returned and pushed) and before posting any reply: run {LIGHT}, {how}, repeating until no Medium-or-higher finding is open (the whole diff only on the human's word); replies wait for it."
    )
}
pub fn if_request(findings: &str, review: &str) -> String {
    format!(
        "craft: if this or any later request in this session — in any language — asks to work review findings or PR comments (triage, replies, fixes), before your first tool call {findings}; if it asks for a review, {review}. These lines apply only to such requests."
    )
}
pub fn reminder_line(findings: &str, review: &str, how: &str) -> String {
    format!(
        "craft: if this request is about review findings, PR comments or a review, the craft lines above apply: {findings} first for findings; {review} for a review; recall memory before triage; before posting replies, run {LIGHT}: {how}."
    )
}

/// The line a subagent's report hears in a session that heard the findings text.
pub fn nudge(codex: bool) -> String {
    let how = if codex {
        CODEX_RE_REVIEW.to_owned()
    } else {
        re_review()
    };
    format!(
        "craft: if this report completes the fixes for the review findings, run {LIGHT}, {how}, before posting replies, until no Medium-or-higher finding is open."
    )
}

fn findings() -> String {
    [
        format!(
            "craft: before your first tool call on this request, make one call: {ADDRESS}. Reading the PRs with gh first does not replace it."
        ),
        recall_line("Skill(\"craft:memory\") and", "right after loading it"),
        re_review_line(&re_review()),
        WHY_FINDINGS.to_owned(),
        launcher("craft:memory", MEMORY),
        format!("craft: {TRIAGE}."),
        delegate_fixes(
            &findings_brief(),
            "once the triage workflow has returned and its dispositions are recorded",
        ),
        off(),
    ]
    .join("\n")
}

fn review() -> String {
    [
        format!(
            "craft: before your first tool call on this request, make one call, here in the main session: Skill(\"craft:develop\") for the review loop up to a PR; for one pass, the craft:review workflow {ROUTES}. Never hand either to a subagent: it has no Workflow tool."
        ),
        "craft: why: craft:review runs the mechanical gate and a fan-out of review lenses per profile (Rust, Nix, and general lenses for other source), then verifies each finding into one report with a verdict; develop loops review → fix until no Medium-or-higher finding is open (at most 4 rounds, then it stops and tells you what is left), then one full review before the PR.".to_owned(),
        launcher("craft:memory", MEMORY),
        format!(
            "craft: delegating a review to a reviewer agent is fine: paste this line verbatim into its brief: {} The fix loop stays here.",
            review_brief()
        ),
        off(),
    ]
    .join("\n")
}

fn other_language() -> String {
    [
        if_request(
            &format!("make one call: {ADDRESS}"),
            &format!(
                "make one call here in the main session: Skill(\"craft:develop\") for the review loop up to a PR, or for one pass the craft:review workflow {ROUTES}; never hand either to a subagent"
            ),
        ),
        recall_line("Skill(\"craft:memory\") and", FOR_FINDINGS),
        re_review_line(&re_review()),
        launcher("craft:memory", MEMORY),
        delegate_both(TRIAGE, &findings_brief()),
        off(),
    ]
    .join("\n")
}

/// The prompt hook's text for a request of `kind`.
pub fn prompt(kind: Kind) -> String {
    match kind {
        Kind::Findings => findings(),
        Kind::Review => review(),
        Kind::OtherLanguage => other_language(),
    }
}

/// The one line a later prompt in another script hears.
pub fn reminder() -> String {
    reminder_line(
        ADDRESS,
        "craft:develop or the review workflow",
        "craft:review { base: <that commit>, fresh: true, delta: true, fullEvery: 0, depth: 'light', extraLenses: [] } on any language",
    )
}

/// What a subagent hears.
pub fn subagent() -> String {
    [
        subagent_work(
            &format!("run {ADDRESS}"),
            "the main session runs the craft:triage-findings workflow, which you lack (no Workflow tool)",
        ),
        subagent_memory(),
        format!("craft: if your brief is only to review: {REVIEWER}."),
        "craft: craft's workflow engines (Workflow tool: craft:review, craft:develop's loop) run only in the main session: report back and leave the review loop there.".to_owned(),
        off(),
    ]
    .join("\n")
}
