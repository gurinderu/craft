//! The skills a task's prompt tells its agent to load (its rubric, a lens brief's skill, the
//! exclusion file of the rubric), each named by the absolute path of its file in the plugin. Any
//! agent with a file-reading tool can then reach the rubric, whatever host runs it and whether or
//! not it has a Skill tool. A skill no path can be found for is said in the prompt, and the report
//! names the run as degraded ([`unresolved`]).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::{PromptContext, plugin_candidates, plugin_path};
use crate::state::Task;

/// A skill named in prose: "the rust-review skill", "Load the sql-review skill".
static NAMED: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)\bthe ([a-z][a-z0-9-]*) skill\b").ok());

/// The skill names `prompt` mentions, each once, in the order they first appear.
fn mentioned(prompt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(re) = NAMED.as_ref() else {
        return out;
    };
    for c in re.captures_iter(prompt) {
        let name = c[1].to_ascii_lowercase();
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// The plugin root the run knows, `None` when it knows none.
fn root(ctx: &PromptContext) -> Option<&Path> {
    ctx.craft_root
        .as_deref()
        .filter(|r| !r.is_empty())
        .map(Path::new)
}

/// The file of skill `name` under the plugin `root`, when it is there.
fn file(root: &Path, name: &str) -> Option<PathBuf> {
    Some(plugin_path(root, &format!("skills/{name}/SKILL.md"))).filter(|p| p.is_file())
}

/// What `prompt` names as skills: each found with its file, and the names left without one. With
/// a root, a word that names no skill of the plugin ("the owning skill") is no skill; without one,
/// every name is left without a file.
fn resolve(ctx: &PromptContext, prompt: &str) -> (Vec<(String, PathBuf)>, Vec<String>) {
    let names = mentioned(prompt);
    let skills = root(ctx).map(|r| plugin_path(r, "skills"));
    // A root that holds no skills at all is as good as none: every name is left without a file.
    let (Some(root), Some(skills)) = (root(ctx), skills.filter(|s| s.is_dir())) else {
        return (Vec::new(), names);
    };
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for name in names {
        match file(root, &name) {
            Some(f) => found.push((name, f)),
            None if skills.join(&name).exists() => missing.push(name),
            None => {}
        }
    }
    (found, missing)
}

/// The block a task's prompt ends with: where each skill it names is, "" when it names none.
#[must_use]
pub fn block(ctx: &PromptContext, prompt: &str) -> String {
    let (found, missing) = resolve(ctx, prompt);
    if found.is_empty() && missing.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n\nSKILL FILES: each skill this task names is a file. Read it with your file tool or `cat` (no Skill tool is needed):",
    );
    for (name, f) in &found {
        let dir = f.parent().unwrap_or(f);
        out.push_str(&format!(
            "\n- `{name}`: `{}` (the files it names, such as rules.md or fp-rules.md, are in `{}/`)",
            f.display(),
            dir.display()
        ));
    }
    for name in &missing {
        out.push_str(&format!(
            "\n- `{name}`: no absolute path is known to this run (craft's plugin root is unknown or holds no such skill). Try {} and expand the variables with Bash. If none is readable, say so in your answer: the report names this run as degraded.",
            plugin_candidates(ctx, &format!("skills/{name}/SKILL.md"))
        ));
    }
    out
}

/// The skills the run's tasks named that no absolute path was found for, each once: the report's
/// degraded note, so a task that judged without its rubric is never read as a clean one.
#[must_use]
pub fn unresolved(ctx: &PromptContext, tasks: &[Task]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tasks {
        for name in resolve(ctx, &t.prompt).1 {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
