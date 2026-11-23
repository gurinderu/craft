//! What a repo declares and whether the hooks speak on it (realm @nick/craft, nodes #275, #264):
//! its project agents and its root rules files, the off switch for one person
//! (`CRAFT_ROLE_HOOK`) or for the repo (a `craft-role-hook: off` line), and the line each hook
//! run logs with that answer.

use std::fs;
use std::path::{Path, PathBuf};

use craft_store::js::JsStr;

use super::entry::Entry;
use super::js::{self, Re, compile};
use super::{Ctx, Harness, iso, key};

/// The environment variable that switches the hooks off for one person or machine.
pub const SWITCH_ENV: &str = "CRAFT_ROLE_HOOK";
const OFF_VALUES: [&str; 4] = ["0", "off", "false", "no"];
static OFF_LINE: Re = Re::new(|| compile(r"(?imR)^[ \t]*craft-role-hook:[ \t]*off[ \t]*$"));
// A rules file counts as work rules only when it names the review-and-merge process in a phrase
// code prose does not use.
static WORK_RULES: [Re; 6] = [
    Re::new(|| compile(r"(?i){B}pull requests?{B}")),
    Re::new(|| compile(r"{B}PRs?{B}")),
    Re::new(|| compile(r"(?i){B}code reviews?{B}")),
    Re::new(|| compile(r"(?i){B}reviewers?{B}")),
    Re::new(|| compile(r"(?i){B}review loops?{B}")),
    Re::new(|| compile(r"(?i){B}before merg(e|ing){B}")),
];
const RULES_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// A repo's declarations: its project agents (repo-relative) and its rules files' names and text.
pub struct Declared {
    pub agents: Vec<String>,
    pub rules: Vec<(String, String)>,
}

/// The nearest directory above `start` holding `.git` (a directory, or a linked worktree's file);
/// `start` itself when there is none.
pub fn repo_root(start: &Path) -> PathBuf {
    let start = js::resolve(start);
    let mut dir = start.as_path();
    loop {
        if dir.join(".git").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(up) => dir = up,
            None => return start,
        }
    }
}

/// The `*<ext>` entries of `dir` under `root`, sorted; `own_only` leaves out symlinks.
fn project_agents(root: &Path, dir: &str, ext: &str, own_only: bool) -> Vec<String> {
    let Ok(read) = fs::read_dir(root.join(dir)) else {
        return Vec::new();
    };
    let mut out: Vec<String> = read
        .flatten()
        .filter(|e| !(own_only && e.file_type().is_ok_and(|t| t.is_symlink())))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(ext))
        .map(|name| format!("{dir}/{name}"))
        .collect();
    out.sort();
    out
}

/// What the repo at `root` declares: `.claude/agents/*.md`, under Codex also the role files
/// `.codex/agents/*.toml`, under OpenCode also its own `.opencode/agents/*.md`, and the root rules files, one reached twice (a link) read once.
pub fn read(root: &Path, who: Harness) -> Declared {
    let mut agents = project_agents(root, ".claude/agents", ".md", false);
    match who {
        Harness::ClaudeCode => {}
        Harness::Codex => agents.extend(project_agents(root, ".codex/agents", ".toml", false)),
        // Not the links craft's OpenCode installer puts there (#264).
        Harness::OpenCode => agents.extend(project_agents(root, ".opencode/agents", ".md", true)),
    }
    let mut rules = Vec::new();
    let mut seen = Vec::new();
    for name in RULES_FILES {
        let file = root.join(name);
        let Ok(real) = fs::canonicalize(&file) else {
            continue;
        };
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        if let Ok(bytes) = fs::read(&file) {
            rules.push((
                name.to_owned(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
    }
    Declared { agents, rules }
}

/// What the hooks speak on, or why they stay silent: `off-env`, `off-line`, `nothing-declared`.
pub fn decide(declared: &Declared, ctx: &Ctx) -> Result<Vec<String>, &'static str> {
    let switch = ctx.var(SWITCH_ENV).js_trim().to_lowercase();
    if OFF_VALUES.contains(&switch.as_str()) {
        return Err("off-env");
    }
    if declared
        .rules
        .iter()
        .any(|(_, text)| OFF_LINE.is_match(&js::ascii_case(text)))
    {
        return Err("off-line");
    }
    let mut found = declared.agents.clone();
    found.extend(
        declared
            .rules
            .iter()
            .filter(|(_, text)| {
                WORK_RULES
                    .iter()
                    .any(|re| re.is_match(&js::ascii_case(text)))
            })
            .map(|(name, _)| name.clone()),
    );
    if found.is_empty() {
        Err("nothing-declared")
    } else {
        Ok(found)
    }
}

/// The repo test every hook makes at `cwd`: the log line's common part and whether it speaks.
pub fn repo_test(cwd: &Path, session: &str, ctx: &Ctx, event: &str, who: Harness) -> Entry {
    let root = repo_root(cwd);
    let decision = decide(&read(&root, who), ctx);
    Entry {
        ts: iso::format(ctx.now),
        repo: key::repo_key(&root),
        source: String::new(),
        event: event.to_owned(),
        harness: who.name().to_owned(),
        session: session.to_owned(),
        spoke: decision.is_ok(),
        silent: decision.as_ref().err().map(|s| (*s).to_owned()),
        found: decision.unwrap_or_default(),
        kind: None,
        agent: None,
        agent_kind: None,
        readiness: None,
        reason: None,
        background: None,
    }
}

#[cfg(test)]
#[path = "declared_tests.rs"]
mod tests;
