//! A stop asked of a start in flight (`craft review run` on a stopping signal): the gate's tools,
//! the sources' git and the consumers' name search each look at it as they wait, kill what they
//! started and run nothing more, so `start` returns soon after with what it had, saying so.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// What a part cut short by the stop says of itself.
pub const STOPPED: &str = "stopped with the run";

/// Shared between the one that stops and the parts that wait; cloned, one flag.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    /// Asks every part holding this flag to stop.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether a stop was asked.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
