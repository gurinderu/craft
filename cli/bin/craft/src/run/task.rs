//! One task of a pending step as the host runs it (realm @nick/craft, nodes #453, #465): where its
//! prompt, schema and answer are; the prompt body of the agent it names — craft's own from the
//! plugin's agent files, a consumer's from the reviewed repository's `.claude/agents` — put before
//! its prompt; and the plugin root written in wherever the binary's prompts name it through
//! `${CLAUDE_PLUGIN_ROOT}`, which a host's shell or file tool may not expand.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// A task as the step hands it out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Task {
    pub(crate) id: String,
    pub(crate) label: String,
    /// The Claude tier it asks for.
    pub(crate) model: String,
    pub(crate) prompt_file: PathBuf,
    pub(crate) schema_file: PathBuf,
    pub(crate) answer_file: PathBuf,
    pub(crate) agent_type: Option<String>,
    pub(crate) consumer_agent: Option<String>,
    /// What it is for, by which its deadline is set.
    pub(crate) kind: Option<String>,
}

impl Task {
    /// The task in a step's `tasks`, `None` when it is not well-formed.
    pub(crate) fn of(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let file = |k: &str| s(k).map(PathBuf::from).filter(|p| p.is_absolute());
        Some(Self {
            id: s("id")?,
            label: s("label")?,
            model: s("model")?,
            prompt_file: file("promptFile")?,
            schema_file: file("schemaFile")?,
            answer_file: file("answerFile")?,
            agent_type: s("agentType"),
            consumer_agent: s("consumerAgent"),
            kind: s("kind"),
        })
    }
}

/// A pending step's tasks; why not when one is not well-formed or there are none.
pub(crate) fn tasks_of(step: &Value) -> Result<Vec<Task>, String> {
    let tasks: Vec<Task> = step
        .get("tasks")
        .and_then(Value::as_array)
        .map(|ts| ts.iter().map(Task::of).collect::<Option<_>>())
        .ok_or("the step carries no tasks")?
        .ok_or("the step carries a task that is not well-formed")?;
    if tasks.is_empty() {
        return Err("the step carries no tasks".into());
    }
    Ok(tasks)
}

/// The agent a task stands for and its prompt body, "" when it names none or none is found.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Rubric {
    pub(crate) agent: String,
    pub(crate) body: String,
}

impl Rubric {
    /// The agent the task named whose body was not found, "" when there is none such.
    pub(crate) fn missing(&self) -> &str {
        if self.body.is_empty() {
            &self.agent
        } else {
            ""
        }
    }
}

/// An agent's name as a file name, `None` when it could leave its directory.
fn safe(name: &str) -> bool {
    let mut chars = name.chars();
    let first = chars
        .next()
        .is_some_and(|c| c.is_alphanumeric() || c == '_');
    first && name.len() <= 64 && chars.all(|c| c.is_alphanumeric() || "_.-".contains(c))
}

/// A Markdown agent file's body, its frontmatter cut; "" when there is no such file.
fn body_of(file: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(file) else {
        return String::new();
    };
    let cut = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .and_then(|rest| {
            rest.find("\n---")
                .and_then(|end| rest.get(end + 4..))
                .map(|after| after.strip_prefix('\r').unwrap_or(after))
        });
    cut.unwrap_or(&text).trim().to_owned()
}

/// The rubric of `task`: craft's agent from `<root>/agents`, a consumer's from `<repo>/.claude/agents`.
pub(crate) fn rubric_of(task: &Task, root: &Path, repo: &Path) -> Rubric {
    let (agent, dir) = match (&task.consumer_agent, &task.agent_type) {
        (Some(a), _) => (a.clone(), repo.join(".claude").join("agents")),
        (None, Some(a)) => (a.clone(), root.join("agents")),
        (None, None) => return Rubric::default(),
    };
    let body = if safe(&agent) {
        body_of(&dir.join(format!("{agent}.md")))
    } else {
        String::new()
    };
    Rubric { agent, body }
}

/// Every literal `${CLAUDE_PLUGIN_ROOT}` in `text` as the root itself.
pub(crate) fn spell_root(text: &str, root: &Path) -> String {
    text.replace("${CLAUDE_PLUGIN_ROOT}", &root.display().to_string())
}

/// The line that ends every task's message: a host loads none of craft's skills, so a skill the
/// prompt names is read from the plugin's own file.
pub(crate) fn skill_line(root: &Path) -> String {
    let file = root.join("skills").join("<name>").join("SKILL.md");
    format!(
        "A skill named in the prompt or the guidance (such as `rust-review`) is the file {}: read it from there.",
        file.display()
    )
}

/// What goes between an agent's body and the task it runs.
pub(crate) const WHOLE_TASK: &str = "The task below is your whole task: use the guidance above for how to review, but run no gate, give no verdict and write no run record of your own beyond what the task asks.";

/// `task` after the agent's `body`, when it has one.
pub(crate) fn headed(body: &str, task: &str) -> String {
    if body.is_empty() {
        task.to_owned()
    } else {
        format!("{body}\n\n---\n\n{WHOLE_TASK}\n\n{task}")
    }
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
