//! Many agents under a concurrency cap, each one's start and end reported on a channel.

use std::num::NonZeroUsize;
use std::sync::Arc;

use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest};

/// What happened to the request at `index` of the batch.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    Started { index: usize },
    Finished { index: usize, reply: AgentReply },
    Failed { index: usize, error: String },
}

/// How a batch ended: every run done, or stopped with the runs that had finished by then.
#[derive(Debug)]
pub enum Batch {
    Complete(Vec<Result<AgentReply, AgentError>>),
    /// Request order; `None` for a run that was cut off or never started.
    Stopped(Vec<Option<Result<AgentReply, AgentError>>>),
}

/// Runs every request, at most `concurrency` at once, and returns the outcomes in request order.
/// Events go to `events`; a closed receiver does not stop the runs.
///
/// # Panics
/// Re-raises a panic from a backend's run.
pub async fn run_all<B>(
    backend: Arc<B>,
    requests: Vec<AgentRequest>,
    concurrency: NonZeroUsize,
    events: mpsc::UnboundedSender<RunEvent>,
) -> Vec<Result<AgentReply, AgentError>>
where
    B: AgentBackend + 'static,
{
    match run_until(
        backend,
        requests,
        concurrency,
        events,
        std::future::pending(),
    )
    .await
    {
        Batch::Complete(outcomes) => outcomes,
        // `pending` never resolves, so nothing stops the batch.
        Batch::Stopped(slots) => slots.into_iter().flatten().collect(),
    }
}

/// [`run_all`], cut short when `stop` resolves first: every run still going is cancelled and
/// awaited before this returns, so a backend's resources are dropped by then — the `claude-code`
/// backend's process group (the subprocess and what stays in its group) is sent SIGTERM, then
/// SIGKILL after a short grace, which [`crate::settle_stops`] waits out before the process exits
/// (on unix; elsewhere only the subprocess itself is killed). What claude starts in a session of
/// its own, as it does each Bash-tool command, is left to claude.
///
/// # Panics
/// Re-raises a panic from a backend's run.
pub async fn run_until<B, S>(
    backend: Arc<B>,
    requests: Vec<AgentRequest>,
    concurrency: NonZeroUsize,
    events: mpsc::UnboundedSender<RunEvent>,
    stop: S,
) -> Batch
where
    B: AgentBackend + 'static,
    S: Future<Output = ()>,
{
    let permits = Arc::new(Semaphore::new(concurrency.get()));
    let mut tasks = JoinSet::new();
    let count = requests.len();
    for (index, request) in requests.into_iter().enumerate() {
        let (backend, permits, events) =
            (Arc::clone(&backend), Arc::clone(&permits), events.clone());
        tasks.spawn(async move {
            // The semaphore is never closed, so acquiring cannot fail; a closed one would only
            // lift the cap.
            let _permit = permits.acquire_owned().await.ok();
            // A gone receiver means nobody watches; the run goes on.
            let _unwatched = events.send(RunEvent::Started { index });
            let outcome = backend.run(&request).await;
            let event = match &outcome {
                Ok(reply) => RunEvent::Finished {
                    index,
                    reply: reply.clone(),
                },
                Err(e) => RunEvent::Failed {
                    index,
                    error: e.to_string(),
                },
            };
            let _unwatched = events.send(event);
            (index, outcome)
        });
    }
    drop(events);
    let mut slots: Vec<Option<Result<AgentReply, AgentError>>> = (0..count).map(|_| None).collect();
    let mut stop = std::pin::pin!(stop);
    loop {
        tokio::select! {
            biased;
            joined = tasks.join_next() => match joined {
                Some(Ok((index, outcome))) => {
                    if let Some(slot) = slots.get_mut(index) {
                        *slot = Some(outcome);
                    }
                }
                Some(Err(e)) => std::panic::resume_unwind(e.into_panic()),
                None => return Batch::Complete(slots.into_iter().flatten().collect()),
            },
            () = &mut stop => {
                tasks.shutdown().await;
                return Batch::Stopped(slots);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::Usage;

    /// Sleeps, counting how many runs overlap; a label starting with `fail` fails, one starting
    /// with `slow` takes an hour.
    #[derive(Default)]
    struct Fake {
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    impl AgentBackend for Fake {
        async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            let pause = if request.label.starts_with("slow") {
                Duration::from_secs(3600)
            } else {
                Duration::from_millis(10)
            };
            tokio::time::sleep(pause).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            if request.label.starts_with("fail") {
                return Err(AgentError::NotYet { backend: "fake" });
            }
            Ok(AgentReply {
                structured: None,
                text: Some(request.label.clone()),
                usage: Usage {
                    output: 1,
                    ..Usage::default()
                },
                cost_usd: 0.5,
                denials: Vec::new(),
            })
        }
    }

    fn req(label: &str) -> AgentRequest {
        AgentRequest {
            label: label.into(),
            agent: None,
            prompt: String::new(),
            model: None,
            schema: None,
            allowed_tools: Vec::new(),
            cwd: PathBuf::from("."),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn never_more_than_the_cap_at_once_and_outcomes_in_request_order() {
        let fake = Arc::new(Fake::default());
        let labels = ["a", "b", "fail-c", "d", "e", "f", "g"];
        let (tx, mut rx) = mpsc::unbounded_channel();
        let out = run_all(
            Arc::clone(&fake),
            labels.iter().map(|l| req(l)).collect(),
            NonZeroUsize::new(3).unwrap(),
            tx,
        )
        .await;

        assert_eq!(fake.peak.load(Ordering::SeqCst), 3);
        let texts: Vec<_> = out
            .iter()
            .map(|o| o.as_ref().ok().and_then(|r| r.text.clone()))
            .collect();
        assert_eq!(
            texts,
            ["a", "b", "", "d", "e", "f", "g"].map(|s| (!s.is_empty()).then(|| s.to_owned()))
        );
        assert!(matches!(out[2], Err(AgentError::NotYet { .. })));

        let mut started = 0;
        let mut ended = 0;
        while let Ok(event) = rx.try_recv() {
            match event {
                RunEvent::Started { .. } => started += 1,
                RunEvent::Finished { .. } | RunEvent::Failed { .. } => ended += 1,
            }
        }
        assert_eq!((started, ended), (labels.len(), labels.len()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_receiver_does_not_stop_the_runs() {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        let out = run_all(
            Arc::new(Fake::default()),
            vec![req("a"), req("b")],
            NonZeroUsize::MIN,
            tx,
        )
        .await;
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(Result::is_ok));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_cancels_the_runs_still_going_and_keeps_the_finished() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let fake = Arc::new(Fake::default());
        let batch = run_until(
            Arc::clone(&fake),
            vec![req("a"), req("slow-b")],
            NonZeroUsize::new(2).unwrap(),
            tx,
            tokio::time::sleep(Duration::from_secs(1)),
        )
        .await;
        let Batch::Stopped(slots) = batch else {
            panic!("the batch was not stopped: {batch:?}");
        };
        assert_eq!(slots.len(), 2);
        assert_eq!(
            slots[0]
                .as_ref()
                .and_then(|o| o.as_ref().ok())
                .and_then(|r| r.text.clone()),
            Some("a".to_owned())
        );
        assert!(slots[1].is_none());
        // The cancelled run was dropped mid-sleep, so it never left.
        assert_eq!(fake.active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_that_never_comes_lets_the_batch_complete() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let batch = run_until(
            Arc::new(Fake::default()),
            vec![req("a")],
            NonZeroUsize::MIN,
            tx,
            std::future::pending(),
        )
        .await;
        assert!(
            matches!(batch, Batch::Complete(ref v) if v.len() == 1),
            "{batch:?}"
        );
    }
}
