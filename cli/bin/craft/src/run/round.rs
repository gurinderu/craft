//! One step's tasks (realm @nick/craft, node #453): each through the host's backend as its own
//! process, at most `concurrency` at once (`craft_agent::runner`), each until its kind's deadline;
//! then what the next submit tells the binary. A task past its deadline is abandoned, which the
//! binary fails at once; one that failed or gave no answer is left unanswered, for the binary to
//! hand out again. Once a task ran into the account's usage limit, or found the host not logged in,
//! no other is started: the limit goes to the submit (`--limit`), a missing login stops the run.

use std::collections::{BTreeMap, HashMap};
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use craft_agent::runner::{Batch, run_until};
use craft_agent::{AgentBackend, AgentError, AgentReply, AgentRequest};
use craft_review::blocked;

use super::deadline::deadline_of;
use super::events::Event;
use super::host::Host;
use super::outcome::{Outcome, outcome_of};
use super::prepare::{Prepared, prepare};
use super::task::Task;
use super::watch::{Named, watch};

/// What a round runs with.
#[derive(Clone)]
pub(crate) struct RoundCtx<'a> {
    pub(crate) host: &'a Host,
    pub(crate) root: &'a Path,
    pub(crate) repo: &'a Path,
    pub(crate) concurrency: NonZeroUsize,
    /// Every task's deadline, in place of its kind's (tests).
    pub(crate) deadline: Option<Duration>,
    pub(crate) log: &'a dyn Fn(&str),
    /// Where each event of the round goes (`--events json`).
    pub(crate) emit: &'a dyn Fn(Event),
    /// The exit status of a stopping signal once one arrived: the round's tasks are stopped then
    /// (realm @nick/craft, node #40).
    pub(crate) stop: tokio::sync::watch::Receiver<Option<u8>>,
}

/// What came of a round.
#[derive(Debug, Default)]
pub(crate) struct RoundResult {
    pub(crate) abandoned: Vec<String>,
    pub(crate) degraded: Vec<String>,
    pub(crate) limit: Option<String>,
    pub(crate) login: Option<String>,
    /// The tasks whose process was started, or that were tried and could not be.
    pub(crate) dispatched: u64,
    /// The last error line of each task that gave no answer.
    pub(crate) errors: Vec<String>,
    /// No task of the round answered.
    pub(crate) all_died: bool,
}

/// The host's backend with each request's deadline, started only while no task has stopped the run.
struct Gated<B> {
    inner: B,
    host: Host,
    deadlines: HashMap<String, Duration>,
    stopped: AtomicBool,
}

impl<B: AgentBackend> AgentBackend for Gated<B> {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(AgentError::NotStarted);
        }
        let deadline = self
            .deadlines
            .get(&request.label)
            .copied()
            .unwrap_or_else(|| deadline_of(None));
        let ran = tokio::time::timeout(deadline, self.inner.run(request))
            .await
            .unwrap_or(Err(AgentError::TimedOut(deadline)));
        if let Err(e) = &ran
            && super::outcome::stops(&self.host, e)
        {
            self.stopped.store(true, Ordering::SeqCst);
        }
        ran
    }
}

/// Runs `tasks` through `backend`, their answers written to their answer files.
pub(crate) async fn run_round<B: AgentBackend + 'static>(
    backend: B,
    tasks: &[Task],
    round: usize,
    ctx: &RoundCtx<'_>,
) -> RoundResult {
    let prepared = prepare(tasks, ctx);
    let notes = prepared.notes(round, ctx.host.name());
    let Prepared {
        requests,
        ran,
        mut outcomes,
        ..
    } = prepared;
    let deadlines = tasks
        .iter()
        .map(|t| {
            let d = ctx
                .deadline
                .unwrap_or_else(|| deadline_of(t.kind.as_deref()));
            (t.id.clone(), d)
        })
        .collect();
    let gated = Arc::new(Gated {
        inner: backend,
        host: ctx.host.clone(),
        deadlines,
        stopped: AtomicBool::new(false),
    });
    let named = Named::of(&requests, &ran, tasks);
    let (events, heard) = tokio::sync::mpsc::unbounded_channel();
    let mut stop = ctx.stop.clone();
    let stopped = async move {
        // A sender gone without a signal never stops the round.
        if stop.wait_for(Option::is_some).await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    let (batch, ()) = tokio::join!(
        run_until(gated, requests, ctx.concurrency, events, stopped),
        watch(heard, &named, ctx.emit)
    );
    let replies: Vec<_> = match batch {
        Batch::Complete(replies) => replies,
        Batch::Stopped(slots) => slots
            .into_iter()
            .map(|s| {
                s.unwrap_or_else(|| {
                    Err(AgentError::Failed {
                        subtype: "stopped".into(),
                    })
                })
            })
            .collect(),
    };
    for (i, reply) in ran.into_iter().zip(replies) {
        if let Some(task) = tasks.get(i) {
            outcomes.insert(i, outcome_of(task, reply, ctx.host));
        }
    }
    let r = gather(tasks, &outcomes, notes, ctx.log);
    for note in &r.degraded {
        (ctx.emit)(Event::Degraded { note: note.clone() });
    }
    if let Some(text) = &r.limit {
        (ctx.emit)(Event::UsageLimit { text: text.clone() });
    }
    r
}

/// The round's result from each task's outcome, the tasks never started left out.
fn gather(
    tasks: &[Task],
    outcomes: &BTreeMap<usize, Outcome>,
    degraded: Vec<String>,
    log: &dyn Fn(&str),
) -> RoundResult {
    let mut r = RoundResult {
        degraded,
        ..RoundResult::default()
    };
    let mut answered = false;
    for (i, o) in outcomes {
        let Some(task) = tasks.get(*i) else { continue };
        if !matches!(o, Outcome::NotStarted) {
            r.dispatched += 1;
        }
        if let Some(line) = o.log_line() {
            log(&format!("⚠️ task {}: {line}", task.label));
        }
        match o {
            Outcome::Answered => answered = true,
            Outcome::Abandoned => r.abandoned.push(task.id.clone()),
            Outcome::Limit(text) => {
                r.limit.get_or_insert_with(|| text.clone());
            }
            Outcome::Login(why) => {
                r.login.get_or_insert_with(|| why.clone());
            }
            Outcome::Unanswered { said, .. } => r.errors.extend(said.clone()),
            Outcome::Blocked(why) => r.errors.push(blocked::failure(why)),
            Outcome::NotStarted => {}
        }
    }
    if let Some(limit) = &r.limit {
        log(&format!(
            "⛔ usage limit reached ({limit}) — no further task is started; the run reports what it has as INCOMPLETE"
        ));
    }
    r.all_died = r.dispatched > 0 && !answered;
    r
}

#[cfg(test)]
#[path = "round_tests.rs"]
mod tests;
