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
/// its end, a timeout, a stop. The grace runs on a thread of its own, which dies with the process:
/// whoever ends the process calls [`settle_stops`] first, or the SIGKILL may never be sent. A no-op off
/// unix.
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
    use std::sync::{Mutex, PoisonError};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    /// How long the group has between SIGTERM and SIGKILL.
    const GRACE: Duration = Duration::from_secs(2);
    /// How often a stopping group is checked for being gone.
    const POLL: Duration = Duration::from_millis(20);

    /// The threads still inside a group's grace, joined by [`settle_stops`](super::settle_stops).
    static STOPPING: Mutex<Vec<JoinHandle<()>>> = Mutex::new(Vec::new());

    pub(super) fn stop(pgid: Pid) {
        // An error means the group is gone already (ESRCH): nothing to stop.
        if killpg(pgid, Signal::SIGTERM).is_err() {
            return;
        }
        // Drop cannot wait; a thread finishes the job. The group id could in principle be reused
        // within the grace, but only by a new process made leader of a group of its own pid — the
        // same pid the kernel would have to hand out again within two seconds.
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + GRACE;
            while Instant::now() < deadline {
                // Signal 0 only asks whether the group still has a member.
                if killpg(pgid, None).is_err() {
                    return;
                }
                std::thread::sleep(POLL);
            }
            // Gone by now is a usual case, not an error.
            let _gone = killpg(pgid, Signal::SIGKILL);
        });
        let mut stopping = STOPPING.lock().unwrap_or_else(PoisonError::into_inner);
        stopping.retain(|t| !t.is_finished());
        stopping.push(thread);
    }

    pub(super) fn settle() {
        let stopping =
            std::mem::take(&mut *STOPPING.lock().unwrap_or_else(PoisonError::into_inner));
        for thread in stopping {
            // The thread only signals; a panic there leaves nothing more to do here.
            let _panicked = thread.join();
        }
    }
}
