//! What came of one task's process, by the one rule both hosts follow (realm @nick/craft, node
//! #453): an answer is written to the task's answer file; past the deadline the task is abandoned;
//! a failure that says the account's usage limit, or that the host is not logged in, stops the run;
//! any other failure, and a process that gave no answer, is left unanswered — the binary hands it
//! out again.

use craft_agent::{AgentError, AgentReply};
use craft_review::blocked;

use super::host::Host;
use super::limit::usage_limit_text;
use super::task::Task;

/// One task's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Answered,
    Abandoned,
    /// The usage limit, as the host said it.
    Limit(String),
    /// Why the host is not logged in, and how to log in.
    Login(String),
    /// `said`: the last line the process wrote on stderr, when it wrote one.
    Unanswered {
        why: String,
        said: Option<String>,
    },
    /// The run stopped before the task's turn came.
    NotStarted,
    /// It answered that it could not look, with why: its answer is written, and the binary fails
    /// the task with that reason (realm @nick/craft, node #511).
    Blocked(String),
}

impl Outcome {
    /// The log line of an outcome that is not an answer.
    pub(crate) fn log_line(&self) -> Option<String> {
        match self {
            Self::Answered | Self::NotStarted => None,
            Self::Abandoned => Some("abandoned — past its deadline".into()),
            Self::Limit(t) => Some(format!("limit — {t}")),
            Self::Login(t) => Some(format!("login — {t}")),
            Self::Unanswered { why, .. } => Some(format!("unanswered — {why}")),
            Self::Blocked(why) => Some(blocked::failure(why)),
        }
    }
}

/// The last non-empty line of `text`, cut to 300 characters.
fn last_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(|l| l.chars().take(300).collect())
}

/// The last lines of what a process said, as one line.
fn tail(stderr: &str, stdout: &str) -> String {
    let all = format!("{stderr}\n{stdout}");
    let lines: Vec<&str> = all.trim().lines().collect();
    let from = lines.len().saturating_sub(3);
    let joined = lines.get(from..).unwrap_or_default().join(" ");
    joined.chars().take(300).collect()
}

/// Whether the failure `e` stops the run: the usage limit, or no login.
pub(crate) fn stops(host: &Host, e: &AgentError) -> bool {
    match e {
        AgentError::Quit { stderr, stdout, .. } => {
            let said = format!("{stderr}\n{stdout}");
            usage_limit_text(&said).is_some() || host.not_logged_in(&said).is_some()
        }
        AgentError::Spawn { .. }
        | AgentError::Io(_)
        | AgentError::TimedOut(_)
        | AgentError::Exit { .. }
        | AgentError::Unreadable(_)
        | AgentError::NotAnObject
        | AgentError::Failed { .. }
        | AgentError::NoStructuredOutput
        | AgentError::NotYet { .. }
        | AgentError::NoAnswer { .. }
        | AgentError::NotStarted => false,
    }
}

/// A failed exit's outcome.
fn quit(host: &Host, code: Option<i32>, stderr: &str, stdout: &str) -> Outcome {
    let said = format!("{stderr}\n{stdout}");
    if let Some(limit) = usage_limit_text(&said) {
        return Outcome::Limit(limit);
    }
    if let Some(login) = host.not_logged_in(&said) {
        return Outcome::Login(login);
    }
    let code = code.map_or_else(|| "on a signal".to_owned(), |c| c.to_string());
    Outcome::Unanswered {
        why: format!("{} exited {code}: {}", host.name(), tail(stderr, stdout)),
        said: last_line(stderr),
    }
}

/// The outcome of `task`'s run, its answer written when it gave one.
pub(crate) fn outcome_of(
    task: &Task,
    reply: Result<AgentReply, AgentError>,
    host: &Host,
) -> Outcome {
    match reply {
        Ok(r) => write_answer(task, &r),
        Err(AgentError::NotStarted) => Outcome::NotStarted,
        Err(AgentError::TimedOut(_)) => Outcome::Abandoned,
        Err(AgentError::Quit {
            code,
            stderr,
            stdout,
        }) => quit(host, code, &stderr, &stdout),
        Err(AgentError::NoAnswer { stderr, stdout }) => Outcome::Unanswered {
            why: format!("{} gave no answer: {}", host.name(), tail(&stderr, &stdout)),
            said: last_line(&stderr),
        },
        Err(e) => {
            let why = e.to_string();
            Outcome::Unanswered {
                said: last_line(&why),
                why,
            }
        }
    }
}

/// Why the agent of `reply` said it could not look: its shaped answer, else its text read as
/// JSON; `None` when it did not say so.
pub(crate) fn blocked_in(reply: &AgentReply) -> Option<String> {
    let parsed = || {
        let t = reply.text.as_deref()?;
        serde_json::from_str(t.trim()).ok()
    };
    reply
        .structured
        .clone()
        .or_else(parsed)
        .as_ref()
        .and_then(blocked::reason)
}

/// The answer written to the task's file: the shaped one as JSON, else the text as it stands, for
/// the binary to refuse in its own words.
fn write_answer(task: &Task, reply: &AgentReply) -> Outcome {
    let text = match (&reply.structured, &reply.text) {
        (Some(v), _) => format!("{v}\n"),
        (None, Some(t)) => t.clone(),
        (None, None) => String::new(),
    };
    let written = task
        .answer_file
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&task.answer_file, text));
    match written {
        Ok(()) => blocked_in(reply).map_or(Outcome::Answered, Outcome::Blocked),
        Err(e) => Outcome::Unanswered {
            why: format!("its answer could not be written: {e}"),
            said: None,
        },
    }
}
