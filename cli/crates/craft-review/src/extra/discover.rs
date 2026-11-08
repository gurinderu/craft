//! Discovery of the session project's reviewing roles, as `chosenExtraLenses` and
//! `pickRepoReviewers` in the engine choose them (realm @nick/craft, nodes #295, #414): the agent
//! definitions directly under `.claude/agents` at the top of the project the session runs in — read
//! by the binary itself, where the engine asks an agent to list them — kept when their description
//! says they review or audit, names no editing duty, they are not craft's own, and they hold no
//! edit tool. Only on that project: a reviewed repository of another git common dir runs none.

use std::path::{Path, PathBuf};

use super::agent_type_form;
use super::frontmatter::{Definition, read_definitions};
use crate::git;

/// What discovery says when the reviewed repository is not the session's project.
pub const DISCOVERY_SKIPPED: &str = "discovery skipped: repo is not this session's project";

const REVIEW_WORDS: &[&str] = &[
    "review",
    "reviews",
    "reviewer",
    "reviewing",
    "audit",
    "audits",
    "auditor",
    "critic",
    "critique",
    "critiques",
];
const EDIT_VERBS: &[&str] = &[
    "edit",
    "edits",
    "implement",
    "implements",
    "refactor",
    "refactors",
    "apply",
    "applies",
    "write",
    "writes",
    "fix",
    "fixes",
];
const EDIT_OBJECTS: &[&str] = &[
    "code", "file", "files", "change", "changes", "fix", "fixes", "patch", "patches",
];
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// The session project's reviewing agents for a review of `repo`, and what discovery read when it
/// chose none.
#[must_use]
pub fn discover(session: &Path, repo: &Path) -> (Vec<String>, String) {
    if !applies(session, repo) {
        return (Vec::new(), DISCOVERY_SKIPPED.into());
    }
    let root = git::toplevel(session).unwrap_or_else(|_| session.to_path_buf());
    let defs = read_definitions(&root.join(".claude").join("agents"));
    let agents = pick_reviewers(&defs);
    let read = if defs.is_empty() {
        "the session's project declares no agent under .claude/agents".to_owned()
    } else {
        format!(
            "{} agent definition(s) read, none describes itself as reviewing without editing",
            defs.len()
        )
    };
    (agents, read)
}

/// Whether `repo` is the session's project: the same directory, or one git common dir.
fn applies(session: &Path, repo: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().ok();
    if canon(session).is_some() && canon(session) == canon(repo) {
        return true;
    }
    let common = |p: &Path| git::common_dir(p).ok().map(PathBuf::from);
    match (common(session), common(repo)) {
        (Some(a), Some(b)) => canon(&a).is_some() && canon(&a) == canon(&b),
        _ => false,
    }
}

/// The agents among `defs` that review and do not edit, each once.
#[must_use]
pub fn pick_reviewers(defs: &[Definition]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in defs {
        let duty = unnegated(&d.description);
        let picked = agent_type_form(&d.name)
            && !d.name.to_lowercase().starts_with("craft:")
            && has_word(&duty, REVIEW_WORDS)
            && !edits(&duty)
            && !may_edit(&d.tools, &d.disallowed);
        if picked && !out.contains(&d.name) {
            out.push(d.name.clone());
        }
    }
    out
}

/// The words of `s`, lower-cased, as `\b` bounds them: runs of letters, digits and `_`.
fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn has_word(s: &str, set: &[&str]) -> bool {
    words(s).iter().any(|w| set.contains(&w.as_str()))
}

/// `s` with each clause that says what the agent is NOT for (`not for|to|a|an …`, to the next
/// period) taken out: it names no duty.
fn unnegated(s: &str) -> String {
    s.split_inclusive('.')
        .map(|sentence| {
            let lower = sentence.to_ascii_lowercase();
            let cut = lower
                .match_indices("not")
                .find(|&(at, _)| negates(&lower, at));
            match cut.and_then(|(at, _)| sentence.get(..at)) {
                Some(kept) => format!("{kept}{}", if sentence.ends_with('.') { "." } else { "" }),
                None => sentence.to_owned(),
            }
        })
        .collect()
}

/// Whether `lower` holds `not`, whitespace, then `for`, `to`, `a` or `an` as words, at `at`.
fn negates(lower: &str, at: usize) -> bool {
    let before = lower.get(..at).and_then(|b| b.chars().last());
    if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
        return false;
    }
    let rest = lower.get(at + 3..).unwrap_or("");
    let next = rest.trim_start();
    if next.len() == rest.len() {
        return false;
    }
    let word: String = next
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    matches!(word.as_str(), "for" | "to" | "a" | "an")
}

/// Whether a sentence of `duty` names an editing verb and, after it, what it edits.
fn edits(duty: &str) -> bool {
    duty.split('.').any(|sentence| {
        let w = words(sentence);
        w.iter()
            .position(|x| EDIT_VERBS.contains(&x.as_str()))
            .is_some_and(|at| {
                w.iter()
                    .skip(at + 1)
                    .any(|x| EDIT_OBJECTS.contains(&x.as_str()))
            })
    })
}

/// Whether an agent may edit, as `mayEdit`: a `tools` list may when it names an edit tool or `*`;
/// with none it inherits every tool, unless `disallowedTools` takes each edit tool away.
#[must_use]
pub fn may_edit(tools: &str, disallowed: &str) -> bool {
    let names = |s: &str| -> Vec<String> {
        s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '*'))
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let granted = names(tools);
    if !granted.is_empty() {
        return granted
            .iter()
            .any(|t| t == "*" || EDIT_TOOLS.contains(&t.as_str()));
    }
    let denied = names(disallowed);
    !EDIT_TOOLS.iter().all(|t| denied.iter().any(|d| d == t))
}
