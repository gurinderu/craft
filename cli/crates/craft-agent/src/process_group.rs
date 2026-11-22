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
/// whoever ends the process calls [`settle_stops`] first, or the SIGKILL may never be sent. When
/// the OS refuses that thread, the drop runs the grace itself. A no-op off unix.
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

/// Blocks until every group a guard has stopped on a grace thread is gone or has been sent SIGKILL:
/// at most the two-second grace plus the wait to reap a killed leader, about 2.2 s. A grace a drop
/// is running inline, for want of a thread, is not listed and not waited for here: that drop's own
/// thread ends it. Call it before the process exits, so a group that ignores SIGTERM does not
/// outlive craft. A no-op off unix.
pub fn settle_stops() {
    #[cfg(unix)]
    unix::settle();
}

/// Whether a group a guard stopped is still inside its grace: its thread has neither seen the group
/// gone nor sent SIGKILL yet, so [`settle_stops`] would wait for it. A stop whose grace has ended
/// is not counted, settled or not, nor is a grace a drop runs inline on another thread for want of
/// one of its own; nothing stopped, as in every command that runs no agent, is false. Always false
/// off unix.
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
#[path = "process_group_unix.rs"]
mod unix;

#[cfg(test)]
#[cfg(unix)]
#[path = "process_group_tests.rs"]
mod tests;
