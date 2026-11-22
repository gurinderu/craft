//! The exit path's wait for the agents' stopped groups: off the runtime's threads when the OS
//! gives a thread, on this one when it does not, and nothing at all when no grace is running.

use std::io;

/// A job handed to a thread of its own.
pub(crate) type Job = Box<dyn FnOnce() + Send>;

/// What the exit path asks and runs, each a seam its tests replace.
pub(crate) struct Exit {
    /// Whether a stopped group's grace is still running.
    pub(crate) pending: fn() -> bool,
    /// Waits out every running grace.
    pub(crate) settle: fn(),
    /// Starts a job on a thread of its own, or says the OS refused one.
    pub(crate) spawn: fn(Job) -> io::Result<()>,
}

/// The exit path craft runs.
pub(crate) const EXIT: Exit = Exit {
    pending: craft_agent::stops_pending,
    settle: craft_agent::settle_stops,
    spawn: on_thread,
};

impl Exit {
    /// Waits out every running grace: `settle` on a thread `spawn` starts, so the runtime keeps
    /// turning meanwhile, or on this one when the OS refuses the thread — exit then neither panics
    /// nor leaves a group unkilled. Nothing pending starts no thread, so a command that ran no
    /// agent cannot fail at exit on a thread it never needed. A panic in `settle` on its thread is
    /// raised here once it is over, as on this one; the caller has reported its outcome by then.
    pub(crate) async fn wait(&self) {
        if !(self.pending)() {
            return;
        }
        let settle = self.settle;
        let (settled, done) = tokio::sync::oneshot::channel();
        let job: Job = Box::new(move || {
            let _gone = settled.send(std::panic::catch_unwind(settle));
        });
        if (self.spawn)(job).is_err() {
            // This blocks a runtime worker for at most the two-second grace: at exit there is
            // nothing left for it to turn.
            settle();
            return;
        }
        if let Ok(Err(panic)) = done.await {
            std::panic::resume_unwind(panic);
        }
    }
}

/// Starts `job` on a thread of its own, detached.
fn on_thread(job: Job) -> io::Result<()> {
    std::thread::Builder::new()
        .name("craft-settle".to_owned())
        .spawn(job)
        .map(drop)
}

#[cfg(test)]
#[path = "settle_tests.rs"]
mod tests;
