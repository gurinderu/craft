//! A subprocess and what stays in its process group, stopped together.
//!
//! On unix the `claude` subprocess leads a process group of its own, and one signal to the group
//! reaches every process still in it; and a terminal's Ctrl-C, sent to the foreground group,
//! reaches craft alone, which decides what to stop. Only the group is reached: a process that
//! moved to a session or group of its own is not. Claude Code 2.1.319 runs each Bash-tool command
//! in a session of its own, so those commands are left to claude to clean up on SIGTERM, which is
//! not verified. Elsewhere the subprocess alone is killed (tokio's `kill_on_drop`); what it started
//! survives.

use tokio::process::Command;

/// Sets `command` up to start in a group of its own (unix), or to be killed when dropped.
pub(crate) fn isolate(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    command.kill_on_drop(true);
}

/// Stops the group a child started by [`isolate`] leads when dropped: SIGTERM to every member,
/// then SIGKILL to whatever is left after a two-second grace. Dropped on every way out of a run —
/// its end, a timeout, a stop. The grace runs on a thread of its own, which dies with the process;
/// when the OS refuses that thread the grace is deferred to [`settle_stops`], which waits out what
/// is left of it and sends the SIGKILL. Either way whoever ends the process calls [`settle_stops`]
/// first, or the SIGKILL may never be sent. A no-op off unix.
#[derive(Debug)]
pub(crate) struct GroupGuard {
    #[cfg(unix)]
    pgid: Option<nix::unistd::Pid>,
}

impl GroupGuard {
    /// Guards the group `pid` leads; `None` (the child already reaped) guards nothing.
    #[cfg_attr(not(unix), expect(unused_variables, reason = "no groups off unix"))]
    pub(crate) fn new(pid: Option<u32>) -> Self {
        Self {
            #[cfg(unix)]
            pgid: pid
                .and_then(|p| i32::try_from(p).ok())
                .map(nix::unistd::Pid::from_raw),
        }
    }
}

/// Blocks until every group a guard has stopped is gone or has been sent SIGKILL: at most the
/// two-second grace. Call it before the process exits, so a group that ignores SIGTERM does not
/// outlive craft. A no-op off unix.
pub fn settle_stops() {
    #[cfg(unix)]
    unix::settle();
}

/// Whether a group a guard stopped still waits on [`settle_stops`]: its grace thread has neither
/// seen the group gone nor sent SIGKILL yet, or its grace was deferred for want of a thread and is
/// not settled. A stop whose grace thread has ended is not counted, settled or not; nothing
/// stopped, as in every command that runs no agent, is false. Always false off unix.
#[must_use]
pub fn stops_pending() -> bool {
    #[cfg(unix)]
    let pending = unix::pending();
    #[cfg(not(unix))]
    let pending = false;
    pending
}

#[cfg(unix)]
impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            unix::stop(pgid);
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::io;
    use std::sync::{Mutex, PoisonError};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    use nix::unistd::Pid;

    /// How long the group has between SIGTERM and SIGKILL.
    const GRACE: Duration = Duration::from_secs(2);
    /// How often a stopping group is checked for being gone.
    const POLL: Duration = Duration::from_millis(20);
    /// How long a leader sent SIGKILL is waited for to be reaped.
    const KILLED: Duration = Duration::from_millis(200);

    /// One stopped group's grace: on a thread of its own, or deferred to
    /// [`settle_stops`](super::settle_stops) when the OS refused the thread.
    pub(super) enum Stop {
        Thread(JoinHandle<()>),
        Deferred { pgid: Pid, deadline: Instant },
    }

    impl Stop {
        /// Whether [`settle_stops`](super::settle_stops) still has to wait for it: a running
        /// thread, or a deferred grace, which only a settle ends.
        pub(super) fn waits(&self) -> bool {
            match self {
                Self::Thread(t) => !t.is_finished(),
                Self::Deferred { .. } => true,
            }
        }
    }

    /// The stops not yet settled: running graces, deferred ones, and threads finished but not yet
    /// joined, which the next stop prunes. [`settle_stops`](super::settle_stops) takes and ends
    /// them all; [`pending`] counts only those that still wait.
    static STOPPING: Mutex<Vec<Stop>> = Mutex::new(Vec::new());

    /// A grace, handed to a thread of its own.
    pub(super) type Grace = Box<dyn FnOnce() + Send>;

    pub(super) fn stop(pgid: Pid) {
        stop_with(pgid, |grace| {
            std::thread::Builder::new()
                .name("craft-grace".to_owned())
                .spawn(grace)
        });
    }

    /// Sends the group SIGTERM and starts its grace on the thread `spawn` gives, listed under the
    /// lock in the same move, so a check or settle never runs between the two. When the OS
    /// refuses the thread, the grace is listed as deferred: Drop cannot wait it out itself, and
    /// [`settle`] does — the group keeps its two seconds and still gets its SIGKILL.
    pub(super) fn stop_with(pgid: Pid, spawn: impl FnOnce(Grace) -> io::Result<JoinHandle<()>>) {
        // An error means the group is gone already (ESRCH): nothing to stop.
        if killpg(pgid, Signal::SIGTERM).is_err() {
            return;
        }
        let deadline = Instant::now() + GRACE;
        let mut stopping = STOPPING.lock().unwrap_or_else(PoisonError::into_inner);
        prune(&mut stopping);
        // Drop cannot wait; a thread finishes the job. The group id could in principle be reused
        // within the grace, but only by a new process made leader of a group of its own pid — the
        // same pid the kernel would have to hand out again within two seconds.
        stopping.push(match spawn(Box::new(move || wait_out(pgid, deadline))) {
            Ok(thread) => Stop::Thread(thread),
            Err(_) => Stop::Deferred { pgid, deadline },
        });
    }

    /// Drops the stops nothing waits for any more: threads that finished.
    pub(super) fn prune(stops: &mut Vec<Stop>) {
        stops.retain(Stop::waits);
    }

    /// Waits for the group to go until `deadline`, then sends SIGKILL to whatever is left and reaps
    /// the killed leader.
    fn wait_out(pgid: Pid, deadline: Instant) {
        while Instant::now() < deadline {
            // The leader is craft's own child, and until reaped it stays a zombie that still
            // counts as a member, so a group that obeyed SIGTERM would look alive for the whole
            // grace: reap it here. It is already reaped (ECHILD) when its run ended normally;
            // tokio's orphan queue, which holds it after a stop, drops a child found gone.
            // Reaping by pid shares the reuse caveat above: only a new child of craft could
            // take that pid within the grace.
            let _reaped = waitpid(pgid, Some(WaitPidFlag::WNOHANG));
            // Signal 0 only asks whether the group still has a member.
            if killpg(pgid, None).is_err() {
                return;
            }
            std::thread::sleep(POLL);
        }
        // Gone by now is a usual case, not an error.
        if killpg(pgid, Signal::SIGKILL).is_err() {
            return;
        }
        // SIGKILL ends the leader at once: reaped here, it is gone when the settle returns. Not a
        // blocking wait, for the reuse caveat above: a new child of craft on that pid would hold
        // it for as long as it ran.
        let reaped_by = Instant::now() + KILLED;
        while matches!(
            waitpid(pgid, Some(WaitPidFlag::WNOHANG)),
            Ok(WaitStatus::StillAlive)
        ) && Instant::now() < reaped_by
        {
            std::thread::sleep(POLL);
        }
    }

    pub(super) fn pending() -> bool {
        STOPPING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(Stop::waits)
    }

    pub(super) fn settle() {
        let stopping =
            std::mem::take(&mut *STOPPING.lock().unwrap_or_else(PoisonError::into_inner));
        for stop in stopping {
            match stop {
                // The thread only signals; a panic there leaves nothing more to do here.
                Stop::Thread(thread) => {
                    let _panicked = thread.join();
                }
                Stop::Deferred { pgid, deadline } => wait_out(pgid, deadline),
            }
        }
    }

    /// How many stops are listed, settled or not.
    #[cfg(test)]
    pub(super) fn listed() -> usize {
        STOPPING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

#[cfg(test)]
#[cfg(unix)]
#[path = "process_group_tests.rs"]
mod tests;
