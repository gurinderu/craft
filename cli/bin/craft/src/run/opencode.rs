//! What the `opencode` host needs before its first task and for each (realm @nick/craft, nodes
//! #499, #502): an opencode whose agents include craft's read-only `review-task`; and the agent
//! each task runs as — `rust-reviewer` for its own tasks, `review-task` with the Claude Code
//! agent's body for every other, and for a `rust-reviewer` task when that agent is missing, said
//! degraded.

use std::path::Path;
use std::process::Command;

use super::task::Task;

/// The read-only agent every task without one of its own runs on.
pub(crate) const TASK_AGENT: &str = "review-task";
/// The binary's agent kinds that run on an opencode agent of the same name.
const OWN_AGENTS: [&str; 1] = ["rust-reviewer"];

/// The agent a task runs as, and why it runs weaker than asked when it does.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Placement {
    pub(crate) agent: String,
    /// Runs on an agent of its own, whose prompt is its rubric: no body goes first.
    pub(crate) own: bool,
    pub(crate) degraded: Option<String>,
}

/// Where `task` runs, given the agents opencode lists (`None`: unknown, so each is taken as there).
pub(crate) fn placement(task: &Task, agents: Option<&[String]>) -> Placement {
    let own = task
        .consumer_agent
        .is_none()
        .then_some(task.agent_type.as_deref())
        .flatten()
        .filter(|a| OWN_AGENTS.contains(a));
    match own {
        Some(a) if agents.is_none_or(|list| list.iter().any(|l| l == a)) => Placement {
            agent: a.to_owned(),
            own: true,
            degraded: None,
        },
        _ => Placement {
            agent: TASK_AGENT.to_owned(),
            own: false,
            degraded: own.map(str::to_owned),
        },
    }
}

/// The text a command printed on stdout, or why it could not be run.
fn stdout_of(command: &Path, args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| {
            format!(
                "`{} {}` could not run: {e}",
                command.display(),
                args.join(" ")
            )
        })?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "`{} {}` failed: {}",
            command.display(),
            args.join(" "),
            said.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The major version in `opencode --version`'s words (`opencode v2.2.7`, `1.19.5`).
fn major_of(said: &str) -> Option<u64> {
    let word = said.split_whitespace().find(|w| {
        w.trim_start_matches('v')
            .starts_with(|c: char| c.is_ascii_digit())
    })?;
    word.trim_start_matches('v').split('.').next()?.parse().ok()
}

/// The agents `opencode debug agents` lists (2.x), by id; `None` when the list cannot be read.
fn agents_of(said: &str) -> Option<Vec<String>> {
    let list: serde_json::Value = serde_json::from_str(said).ok()?;
    let ids = list
        .as_array()?
        .iter()
        .filter_map(|a| a.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    Some(ids)
}

/// The agents a 1.x `run --agent` runs as named, from `opencode agent list`: one `<name> (<mode>)`
/// line each, between the permission tables it prints. A `subagent` is left out — 1.19.5 runs the
/// default agent, which writes, in its place (observed) — so a task of one runs on `review-task`.
fn agents_listed(said: &str) -> Option<Vec<String>> {
    let names: Vec<String> = said
        .lines()
        .filter_map(|l| l.strip_suffix(')')?.split_once(" ("))
        .filter(|(name, mode)| !name.contains(' ') && ["primary", "all"].contains(mode))
        .map(|(name, _)| name.to_owned())
        .collect();
    (!names.is_empty()).then_some(names)
}

/// What a review runs on in this opencode: the agents it lists (`None` when the list cannot be
/// read), and whether its `run` archives a session (2.x; 1.19.5's takes no `--archived`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Ready {
    pub(crate) agents: Option<Vec<String>>,
    pub(crate) archived: bool,
}

/// The opencode a review can run on, or why it cannot run: an opencode without `review-task`
/// would run every task on another agent or fail it. On 1.x, `review-task` runs as named only as
/// a `mode: all` agent (1.19.5 puts a subagent named to `run --agent` on its default agent, which
/// writes; observed). `log` hears a list it could not read.
pub(crate) fn preflight(command: &Path, repo: &Path, log: &dyn Fn(&str)) -> Result<Ready, String> {
    let version = stdout_of(command, &["--version"], repo)?;
    let Some(major) = major_of(&version) else {
        return Err(format!(
            "`{} --version` said {:?}, not a version",
            command.display(),
            version.trim()
        ));
    };
    let list: &[&str] = if major >= 2 {
        &["debug", "agents"]
    } else {
        &["agent", "list"]
    };
    let agents = stdout_of(command, list, repo)
        .map_err(|e| log(&format!("⚠️ opencode's agents could not be listed ({e}); each task runs on its agent unchecked")))
        .ok()
        .and_then(|said| if major >= 2 { agents_of(&said) } else { agents_listed(&said) });
    if let Some(list) = &agents
        && !list.iter().any(|a| a == TASK_AGENT)
    {
        return Err(format!(
            "the craft OpenCode agents are not installed or are out of date: rerun integrations/opencode/install.sh (this opencode has no `{TASK_AGENT}` agent, which every review task runs on read-only)"
        ));
    }
    // A 1.x list that could not be read is taken as `review-task` alone: a subagent named to its
    // `run` would run as the writable default agent, so none is ever named there.
    let agents = agents.or_else(|| (major < 2).then(|| vec![TASK_AGENT.to_owned()]));
    Ok(Ready {
        agents,
        archived: major >= 2,
    })
}

#[cfg(test)]
#[path = "opencode_tests.rs"]
mod tests;
