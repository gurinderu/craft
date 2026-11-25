//! What came of one task's process, by the one rule both hosts follow (realm @nick/craft, node
//! #453): an answer is written to the task's answer file; past the deadline the task is abandoned;
//! a failure that says the account's usage limit, that the host is not logged in, or — in a delegated
//! run — that the process running the tasks stopped answering (`AgentError::HostGone`), stops the run;
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
    /// Why the process a delegated run hands its tasks to stopped answering (delegate.rs).
    Gone(String),
    /// `said`: the last line the process wrote on stderr, when it wrote one. `wrote`: the last
    /// line the agent's process wrote of why it gave no answer — never craft's own reason, `None`
    /// when it wrote nothing — for the stop on a round that died whole (realm @nick/craft, node
    /// #666).
    Unanswered {
        why: String,
        said: Option<String>,
        wrote: Option<String>,
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
            Self::Gone(t) => Some(format!("stopped — {t}")),
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

/// `text` as one line, capped at 300 characters; `None` when it is blank.
fn one_line(text: &str) -> Option<String> {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one.is_empty()).then(|| one.chars().take(300).collect())
}

/// What a failed exit wrote of why: its last error event's message, as the backend read it
/// (opencode's), else stderr's last line. Its stdout is not why: an event stream or a reply.
fn quit_words(errors: &[String], stderr: &str) -> Option<String> {
    errors
        .last()
        .and_then(|e| one_line(e))
        .or_else(|| last_line(stderr))
}

/// How the opencode plugin opens a failed child session's error (`integrations/opencode/plugin/
/// host-v2.ts`, `ChildSessionFailed`): `the child session failed (<type>)`, then `: <message>`
/// when the runtime gave one.
const CHILD_FAILED: &str = "the child session failed (";
/// How the plugin names the failure of a child tried once more alone (`review-children.ts`).
const RETRIED: &str = "(tried once more alone: ";

/// The runtime's own error in a delegated task's failure, as one line: `<type>: <message>`, the
/// type alone, or the message alone where the plugin had no type (`unknown`). A child tried once
/// more alone is read by its last failure. The plugin's other words — a session that ended another
/// way (`outcome …`), one stopped at its deadline, a type-less error with no message — and the
/// binary's own are craft's, so `None`.
fn runtime_words(subtype: &str) -> Option<String> {
    let at = subtype.rfind(CHILD_FAILED)?;
    let rest = subtype.get(at + CHILD_FAILED.len()..)?;
    let rest = match subtype.get(..at) {
        Some(before) if before.ends_with(RETRIED) => rest.strip_suffix(')').unwrap_or(rest),
        _ => rest,
    };
    let (kind, message) = rest.split_once(')')?;
    let message = message.strip_prefix(": ").unwrap_or(message).trim();
    let words = match kind {
        k if k.starts_with("outcome ") => return None,
        "unknown" => message.to_owned(),
        k if message.is_empty() => k.to_owned(),
        k => format!("{k}: {message}"),
    };
    one_line(&words)
}

/// The last line the agent's process wrote in a failure `e` that is neither a quit nor a clean exit
/// with no answer: a failed exit's stderr, a delegated turn's failure; `None` where the words are
/// craft's own.
fn own_words(e: &AgentError) -> Option<String> {
    match e {
        AgentError::Exit { stderr, .. } => last_line(stderr),
        AgentError::Failed { subtype } => runtime_words(subtype),
        AgentError::Quit { .. }
        | AgentError::NoAnswer { .. }
        | AgentError::Spawn { .. }
        | AgentError::Io(_)
        | AgentError::TimedOut(_)
        | AgentError::Unreadable(_)
        | AgentError::NotAnObject
        | AgentError::NoStructuredOutput
        | AgentError::NotYet { .. }
        | AgentError::HostGone(_)
        | AgentError::NotStarted => None,
    }
}

/// Whether the failure `e` stops the run: the usage limit, or no login.
pub(crate) fn stops(host: &Host, e: &AgentError) -> bool {
    match e {
        AgentError::Quit { stderr, stdout, .. } => {
            let said = format!("{stderr}\n{stdout}");
            usage_limit_text(&said).is_some() || host.not_logged_in(&said).is_some()
        }
        // A delegated task's failure, in the words the delegating process gave (delegate.rs).
        AgentError::Failed { subtype } => usage_limit_text(subtype).is_some(),
        AgentError::HostGone(_) => true,
        AgentError::Spawn { .. }
        | AgentError::Io(_)
        | AgentError::TimedOut(_)
        | AgentError::Exit { .. }
        | AgentError::Unreadable(_)
        | AgentError::NotAnObject
        | AgentError::NoStructuredOutput
        | AgentError::NotYet { .. }
        | AgentError::NoAnswer { .. }
        | AgentError::NotStarted => false,
    }
}

/// A failed exit's outcome.
fn quit(
    host: &Host,
    code: Option<i32>,
    (stderr, stdout): (&str, &str),
    errors: &[String],
) -> Outcome {
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
        wrote: quit_words(errors, stderr),
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
        // No later task can answer: the run stops as on a missing login, to be resumed (round.rs).
        Err(e @ AgentError::HostGone(_)) => Outcome::Gone(e.to_string()),
        Err(AgentError::TimedOut(_)) => Outcome::Abandoned,
        Err(AgentError::Quit {
            code,
            stderr,
            stdout,
            errors,
        }) => quit(host, code, (&stderr, &stdout), &errors),
        Err(AgentError::Failed { subtype }) if let Some(limit) = usage_limit_text(&subtype) => {
            Outcome::Limit(limit)
        }
        Err(AgentError::NoAnswer { stderr, stdout }) => Outcome::Unanswered {
            why: format!("{} gave no answer: {}", host.name(), tail(&stderr, &stdout)),
            said: last_line(&stderr),
            // Its stdout is the agent's reply text, not why it gave none.
            wrote: last_line(&stderr),
        },
        Err(e) => {
            let wrote = own_words(&e);
            let why = e.to_string();
            Outcome::Unanswered {
                said: last_line(&why),
                why,
                wrote,
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
            wrote: None,
        },
    }
}

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod tests;
