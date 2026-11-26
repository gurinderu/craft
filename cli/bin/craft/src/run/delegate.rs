//! The `opencode` host's tasks handed back to the process that runs `craft review run --delegate`
//! (realm @nick/craft, nodes #496, #626, #627): the OpenCode 2.x plugin runs each as a child
//! session of the calling session, which `opencode run` cannot make. A task goes out as a `task`
//! event on the event stream, its key fresh per dispatch and its working directory the repository
//! the run reviews; its reply comes back on stdin as one JSON line, `{"key":n,"text":…}` or
//! `{"key":n,"error":…}` (`delegate_read.rs`). The text is read as an `opencode run` reply is
//! ([`answer_of`]); an error as the agent's failed turn, whose words are read for a usage limit as
//! a failed exit's are, so it stops the run as there. A dispatch dropped before its reply — past
//! its deadline, or its round stopped — is said with a `task_cancelled` event, for the plugin to
//! stop that child. A dispatch whose event could not be written, or made once the input closed,
//! stops the run, resumable: no later task could answer either.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use craft_agent::pi::answer::answer_of;
use craft_agent::{AgentBackend, AgentError, AgentReply, AgentRequest, Usage};
use serde_json::Value;
use tokio::sync::oneshot;

use super::events::Event;
use super::task::Task;

#[path = "delegate_read.rs"]
mod read;

/// A reply: the task's text, or its failure's words.
type Said = Result<String, String>;
type Pending = HashMap<u64, oneshot::Sender<Said>>;

struct Shared {
    next: AtomicU64,
    pending: Mutex<Pending>,
    /// Set once the input closed: no reply can come any more.
    closed: AtomicBool,
    /// Each task's label by its id, for the event.
    labels: Mutex<HashMap<String, String>>,
    /// Writes an event; whether it was written.
    emit: Box<dyn Fn(Event) -> bool + Send + Sync>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// The backend that hands each task to the delegating process.
#[derive(Clone)]
pub(crate) struct Delegate(Arc<Shared>);

impl std::fmt::Debug for Delegate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Delegate")
    }
}

/// Why a dispatch has no reply: the delegating process's input ended, or could not be read.
const CLOSED: &str = "its input to craft ended";
/// Why a dispatch failed before any reply could come: its event was not written.
const UNSENT: &str = "a task could not be handed to it";

/// The run stops on either: no later task could answer (`AgentError::HostGone`, outcome.rs).
fn gone(why: &str) -> AgentError {
    AgentError::HostGone(why.to_owned())
}

impl Delegate {
    /// A delegate whose events go to `emit`, which says whether it wrote one, and whose passed-over
    /// reply lines are said to `log`; replies come through [`Delegate::deliver`].
    pub(crate) fn new(
        emit: impl Fn(Event) -> bool + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(Shared {
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            labels: Mutex::new(HashMap::new()),
            emit: Box::new(emit),
            log: Box::new(log),
        }))
    }

    /// A delegate whose replies are read from the input `input` opens on a thread of their own;
    /// once the input ends, every dispatch still waiting fails, and every later one at once.
    pub(crate) fn reading<I: BufRead + 'static>(
        input: impl FnOnce() -> I + Send + 'static,
        emit: impl Fn(Event) -> bool + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let delegate = Self::new(emit, log);
        let reader = delegate.clone();
        std::thread::spawn(move || reader.read_replies(input()));
        delegate
    }

    /// A delegate whose replies are read from this process's stdin ([`Delegate::reading`]).
    pub(crate) fn on_stdin(
        emit: impl Fn(Event) -> bool + Send + Sync + 'static,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self::reading(|| std::io::stdin().lock(), emit, log)
    }

    /// Names the round's tasks, so each `task` event carries its label.
    pub(crate) fn name(&self, tasks: &[Task]) {
        let mut labels = self.0.labels.lock().unwrap_or_else(PoisonError::into_inner);
        for t in tasks {
            labels.insert(t.id.clone(), t.label.clone());
        }
    }

    /// Every dispatch still waiting fails, and every later one at once: no reply can come any more.
    fn close(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        self.pending().clear();
    }

    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn label_of(&self, id: &str) -> String {
        let labels = self.0.labels.lock().unwrap_or_else(PoisonError::into_inner);
        labels.get(id).cloned().unwrap_or_else(|| id.to_owned())
    }
}

/// A dispatch still waiting when its future is dropped: the delegating process is told to stop it.
struct Waiting<'a> {
    delegate: &'a Delegate,
    key: u64,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.delegate.pending().remove(&self.key).is_some() {
            (self.delegate.0.emit)(Event::TaskCancelled { key: self.key });
        }
    }
}

/// The reply as the round reads an agent's: an answer, no answer, or a failure's words.
fn reply_of(said: Said) -> Result<AgentReply, AgentError> {
    let text = said.map_err(|subtype| AgentError::Failed { subtype })?;
    let Some(answer) = answer_of(&text) else {
        return Err(AgentError::NoAnswer {
            stderr: String::new(),
            stdout: text.trim().to_owned(),
        });
    };
    Ok(AgentReply {
        structured: Some(Value::Object(answer)),
        text: Some(text),
        usage: Usage::default(),
        cost_usd: 0.0,
        denials: Vec::new(),
    })
}

impl AgentBackend for Delegate {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        let key = self.0.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(key, tx);
        // Checked after the insert: a close between the two has cleared it, or is seen here.
        if self.0.closed.load(Ordering::SeqCst) {
            self.pending().remove(&key);
            return Err(gone(CLOSED));
        }
        let waiting = Waiting {
            delegate: self,
            key,
        };
        let sent = (self.0.emit)(Event::Task {
            key,
            id: request.label.clone(),
            label: self.label_of(&request.label),
            agent: request.agent.clone(),
            model: request.model.clone(),
            cwd: request.cwd.display().to_string(),
            prompt: request.prompt.clone(),
        });
        if !sent {
            self.pending().remove(&key);
            return Err(gone(UNSENT));
        }
        let said = rx.await;
        drop(waiting);
        said.map_err(|_closed| gone(CLOSED)).and_then(reply_of)
    }
}

#[cfg(test)]
#[path = "delegate_tests.rs"]
mod tests;
