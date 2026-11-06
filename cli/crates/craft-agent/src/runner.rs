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
    let mut slots: Vec<Option<Result<AgentReply, AgentError>>> = (0..count).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((index, outcome)) => {
                if let Some(slot) = slots.get_mut(index) {
                    *slot = Some(outcome);
                }
            }
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }
    slots.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::Usage;

    /// Sleeps, counting how many runs overlap; a label starting with `fail` fails.
    #[derive(Default)]
    struct Fake {
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    impl AgentBackend for Fake {
        async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
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
}
