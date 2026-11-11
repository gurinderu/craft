//! The host CLI a review's tasks run in (realm @nick/craft, nodes #491, #495, #499, #502): Codex,
//! pi or opencode — how a task becomes its agent's request, what the host says when no account is
//! logged in, and how to log in. Each host's own command line is its backend's
//! (`craft_agent::codex`, `craft_agent::pi`, `craft_agent::opencode`).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use craft_agent::AgentRequest;
use regex::Regex;
use serde_json::Value;

use super::HostKind;
use super::models::ModelTable;
use super::opencode::placement;
use super::task::{Task, headed, skill_line, spell_root};

/// What Codex says with no account logged in (observed with codex-cli 0.167.0).
static CODEX_LOGIN: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?:401 Unauthorized: Missing bearer or basic authentication|Not logged in)[^\n,]*")
        .ok()
});
/// What pi says with no provider logged in (observed with pi 1.5.2).
static PI_LOGIN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"No API key found[^\n]*").ok());

/// A host and what its tasks run with.
#[derive(Debug, Clone)]
pub(crate) struct Host {
    pub(crate) kind: HostKind,
    pub(crate) models: ModelTable,
    /// The host's CLI.
    pub(crate) command: PathBuf,
    /// The agents opencode lists, `None` when unknown or for another host.
    pub(crate) agents: Option<Vec<String>>,
}

impl Host {
    /// The host as the log and the notes name it.
    pub(crate) fn name(&self) -> &'static str {
        match self.kind {
            HostKind::Codex => "Codex",
            HostKind::Pi => "pi",
            HostKind::OpenCode => "OpenCode",
        }
    }

    /// Why no task can answer until the human logs in, when `said` says so.
    pub(crate) fn not_logged_in(&self, said: &str) -> Option<String> {
        let (re, how) = match self.kind {
            HostKind::Codex => (&*CODEX_LOGIN, "run `codex login`"),
            HostKind::Pi => (&*PI_LOGIN, "run `pi` and `/login`"),
            // What opencode says with no provider logged in is not observed (lib/opencode-review*.mjs
            // knows nothing of it either): such a failure is an ordinary one.
            HostKind::OpenCode => return None,
        };
        let found = re.as_ref()?.find(said)?.as_str().trim();
        let name = self.name();
        Some(format!(
            "{name} is not logged in ({found}): log in to {name} — {how} — then resume the run"
        ))
    }

    /// The request `task` runs as, with the agent's `body` first; or why it cannot be read.
    pub(crate) fn request(
        &self,
        task: &Task,
        body: &str,
        (root, repo): (&Path, &Path),
    ) -> Result<AgentRequest, String> {
        let read = |p: &Path| {
            std::fs::read_to_string(p)
                .map_err(|e| format!("{} could not be read: {e}", p.display()))
        };
        let prompt = read(&task.prompt_file)?;
        let (prompt, schema, agent) = match self.kind {
            HostKind::Codex => {
                let schema: Value = serde_json::from_str(&read(&task.schema_file)?)
                    .map_err(|e| format!("its schema is not JSON: {e}"))?;
                (codex_input(body, &prompt, root), Some(schema), None)
            }
            HostKind::Pi => {
                let file = pi_prompt_file(task, &prompt, root)?;
                (pi_message(body, task, &file, root), None, None)
            }
            HostKind::OpenCode => {
                let place = placement(task, self.agents.as_deref());
                let body = if place.own { "" } else { body };
                let file = pi_prompt_file(task, &prompt, root)?;
                (pi_message(body, task, &file, root), None, Some(place.agent))
            }
        };
        Ok(AgentRequest {
            label: task.id.clone(),
            agent,
            prompt,
            model: self.models.get(&task.model).cloned(),
            schema,
            allowed_tools: Vec::new(),
            cwd: repo.to_path_buf(),
        })
    }
}

/// What a Codex task reads on stdin: the agent's body, if any, then the task's own prompt, then
/// where craft's skills are.
pub(crate) fn codex_input(body: &str, prompt: &str, root: &Path) -> String {
    let task = format!(
        "{}\n\nYour final message is your answer: the JSON the output schema describes, and nothing else.\n\n{}\n",
        prompt.trim(),
        skill_line(root)
    );
    spell_root(&headed(body, &task), root)
}

/// The prompt file a pi or opencode task reads: its own, or — where it names craft's files under
/// `${CLAUDE_PLUGIN_ROOT}`, which pi's read tool does not expand — a copy beside it with the root
/// written in.
fn pi_prompt_file(task: &Task, prompt: &str, root: &Path) -> Result<PathBuf, String> {
    let spelled = spell_root(prompt, root);
    if spelled == prompt {
        return Ok(task.prompt_file.clone());
    }
    let file = task.prompt_file.with_extension("pi.md");
    std::fs::write(&file, spelled)
        .map_err(|e| format!("{} could not be written: {e}", file.display()))?;
    Ok(file)
}

/// The message a pi or opencode task is given: the agent's body, if any, then the task, which reads its prompt
/// file and prints its answer in a `craft-answer` block, then where craft's skills are.
pub(crate) fn pi_message(body: &str, task: &Task, prompt_file: &Path, root: &Path) -> String {
    let what = format!(
        "Read the file {} and do exactly what it says: it is your whole task — run no gate, give no verdict and write no run record of your own beyond what it asks. When done, print your answer as one JSON object at the end of your reply, in a fenced block of its own opened with ```craft-answer and closed with ```, matching the schema in {}; put nothing else in that block, and no example after it in one. Do not write or change any file.",
        prompt_file.display(),
        task.schema_file.display()
    );
    spell_root(
        &format!("{}\n\n{}", headed(body, &what), skill_line(root)),
        root,
    )
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
