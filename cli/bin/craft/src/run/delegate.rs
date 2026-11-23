//! The `opencode` host's tasks handed back to the process that runs `craft review run --delegate`
//! (realm @nick/craft, nodes #496, #626): the OpenCode 2.x plugin runs each as a child session of
//! the calling session, which `opencode run` cannot make. A task goes out as a `task` event on the
//! event stream, its key fresh per dispatch; its reply comes back on stdin as one JSON line,
//! `{"key":n,"text":…}` or `{"key":n,"error":…}`. The text is read as an `opencode run` reply is
//! ([`answer_of`]); an error as the agent's failed turn, whose words are read for a usage limit as
//! a failed exit's are, so it stops the run as there. A dispatch dropped before its reply — past its deadline, or its round stopped — is said
//! with a `task_cancelled` event, for the plugin to stop that child.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use craft_agent::pi::answer::answer_of;
use craft_agent::{AgentBackend, AgentError, AgentReply, AgentRequest, Usage};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

use super::events::Event;
use super::task::Task;

/// What the delegating process sent back for one dispatch.
#[derive(Debug, Deserialize)]
struct Reply {
    key: u64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

type Emit = Box<dyn Fn(Event) + Send + Sync>;

struct Shared {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<String, String>>>>,
    /// Each task's label by its id, for the event.
    labels: Mutex<HashMap<String, String>>,
    emit: Emit,
}

/// The backend that hands each task to the delegating process.
#[derive(Clone)]
pub(crate) struct Delegate(Arc<Shared>);

impl std::fmt::Debug for Delegate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Delegate")
    }
}

/// Why a dispatch has no reply: the delegating process closed its input first.
const CLOSED: &str = "the process that delegates the tasks closed its input";

impl Delegate {
    /// A delegate whose events go to `emit`; replies come through [`Delegate::deliver`].
    pub(crate) fn new(emit: impl Fn(Event) + Send + Sync + 'static) -> Self {
        Self(Arc::new(Shared {
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            labels: Mutex::new(HashMap::new()),
            emit: Box::new(emit),
        }))
    }

    /// A delegate whose replies are read from this process's stdin, on a thread of their own;
    /// once stdin ends, every dispatch still waiting fails.
    pub(crate) fn on_stdin(emit: impl Fn(Event) + Send + Sync + 'static) -> Self {
        let delegate = Self::new(emit);
        let reader = delegate.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                reader.deliver(&line);
            }
            reader.close();
        });
        delegate
    }

    /// Names the round's tasks, so each `task` event carries its label.
    pub(crate) fn name(&self, tasks: &[Task]) {
        let mut labels = self.0.labels.lock().unwrap_or_else(PoisonError::into_inner);
        for t in tasks {
            labels.insert(t.id.clone(), t.label.clone());
        }
    }

    /// One reply line handed to the dispatch it names; a line that is no reply, or names no
    /// dispatch still waiting, is passed over. Whether it was taken.
    pub(crate) fn deliver(&self, line: &str) -> bool {
        let Ok(reply) = serde_json::from_str::<Reply>(line) else {
            return false;
        };
        let said = match (reply.text, reply.error) {
            (_, Some(error)) => Err(error),
            (Some(text), None) => Ok(text),
            (None, None) => return false,
        };
        let waiting = self.pending().remove(&reply.key);
        waiting.is_some_and(|tx| tx.send(said).is_ok())
    }

    /// Every dispatch still waiting fails: no reply can come any more.
    fn close(&self) {
        self.pending().clear();
    }

    fn pending(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Result<String, String>>>> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
fn reply_of(said: Result<String, String>) -> Result<AgentReply, AgentError> {
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
        let waiting = Waiting {
            delegate: self,
            key,
        };
        let label = self
            .0
            .labels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&request.label)
            .cloned()
            .unwrap_or_else(|| request.label.clone());
        (self.0.emit)(Event::Task {
            key,
            id: request.label.clone(),
            label,
            agent: request.agent.clone(),
            model: request.model.clone(),
            prompt: request.prompt.clone(),
        });
        let said = rx.await;
        drop(waiting);
        reply_of(said.unwrap_or_else(|_closed| Err(CLOSED.to_owned())))
    }
}

#[cfg(test)]
#[path = "delegate_tests.rs"]
mod tests;
