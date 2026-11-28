//! A test's event stream, for the event stream's own tests (`events_tests.rs`), for
//! `delegate`'s and for the run's end (`mod_tests.rs`): a stream that takes a line as soon as
//! it is given, holds its first at a gate, takes time over each line or both, and keeps what it
//! was given and the thread that took it.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

/// Holds the writer at its first line until opened.
#[derive(Default)]
pub(crate) struct Gate {
    /// Whether the writer arrived, and whether it may go on.
    at: Mutex<(bool, bool)>,
    opened: Condvar,
}

impl Gate {
    /// The writer's side: says it arrived and waits until the gate opens.
    pub(super) fn reach(&self) {
        let mut at = self.at.lock().unwrap_or_else(PoisonError::into_inner);
        at.0 = true;
        while !at.1 {
            at = self.opened.wait(at).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Whether the writer arrived.
    pub(crate) fn arrived(&self) -> bool {
        self.at.lock().unwrap_or_else(PoisonError::into_inner).0
    }

    /// Lets the writer go on.
    pub(crate) fn open(&self) {
        self.at.lock().unwrap_or_else(PoisonError::into_inner).1 = true;
        self.opened.notify_all();
    }
}

/// What the stream was given, and by which thread.
#[derive(Default)]
pub(crate) struct Kept {
    given: Mutex<(Vec<Vec<u8>>, Vec<ThreadId>)>,
    gate: Option<Arc<Gate>>,
    delay: Duration,
}

impl Kept {
    /// A stream that takes a line as soon as it is given.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// A stream whose first line waits at `gate`.
    pub(crate) fn at(gate: &Arc<Gate>) -> Self {
        Self {
            gate: Some(Arc::clone(gate)),
            ..Self::default()
        }
    }

    /// A stream that takes `delay` over each line.
    pub(crate) fn slow(delay: Duration) -> Self {
        Self {
            delay,
            ..Self::default()
        }
    }

    /// A stream whose first line waits at `gate` and that then takes `delay` over each line.
    pub(crate) fn slow_at(gate: &Arc<Gate>, delay: Duration) -> Self {
        Self {
            gate: Some(Arc::clone(gate)),
            delay,
            ..Self::default()
        }
    }

    fn take(&self, line: &str) -> bool {
        if let Some(gate) = &self.gate {
            gate.reach();
        }
        thread::sleep(self.delay);
        let mut given = self.given.lock().unwrap_or_else(PoisonError::into_inner);
        given.0.push(line.as_bytes().to_vec());
        given.1.push(thread::current().id());
        true
    }

    /// The lines the stream took so far, each with its newline.
    pub(crate) fn lines(&self) -> Vec<String> {
        self.given
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .0
            .iter()
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect()
    }

    /// The thread that took each line the stream took so far.
    pub(crate) fn writers(&self) -> Vec<ThreadId> {
        self.given
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .1
            .clone()
    }
}

/// The writer of a test sink's stream: what it is given goes to `kept`.
pub(crate) fn writing(kept: &Arc<Kept>) -> impl FnMut(&str) -> bool + Send + 'static {
    let kept = Arc::clone(kept);
    move |line| kept.take(line)
}

/// Up to five seconds for `so` to hold: whether it did.
pub(crate) fn waited_until(mut so: impl FnMut() -> bool) -> bool {
    let by = Instant::now() + Duration::from_secs(5);
    while !so() && Instant::now() < by {
        thread::sleep(Duration::from_millis(1));
    }
    so()
}
