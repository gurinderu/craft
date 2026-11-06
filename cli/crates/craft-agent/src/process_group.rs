//! A subprocess and everything it starts, stopped together.
//!
//! On unix the `claude` subprocess leads a process group of its own, so the tools it starts (Bash
//! commands, MCP servers) are in that group too and one signal reaches them all; and a terminal's
//! Ctrl-C, sent to the foreground group, reaches craft alone, which decides what to stop.
//! Elsewhere the subprocess alone is killed (tokio's `kill_on_drop`); what it started survives.

use std::time::Duration;

use tokio::process::Command;

/// How long the group has between SIGTERM and SIGKILL.
const GRACE: Duration = Duration::from_secs(2);

/// Sets `command` up to start in a group of its own (unix), or to be killed when dropped.
pub(crate) fn isolate(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    command.kill_on_drop(true);
}

/// Stops the group a child started by [`isolate`] leads when dropped: SIGTERM to every member,
/// then SIGKILL to whatever is left after [`GRACE`]. Dropped on every way out of a run — its end,
/// a timeout, a stop — so nothing the child started outlives the run. A no-op off unix.
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

#[cfg(unix)]
impl Drop for GroupGuard {
    fn drop(&mut self) {
        use nix::sys::signal::{Signal, killpg};
        let Some(pgid) = self.pgid else { return };
        // An error means the group is gone already (ESRCH): nothing to stop.
        if killpg(pgid, Signal::SIGTERM).is_err() {
            return;
        }
        // Drop cannot wait; a detached thread finishes the job. The group id could in principle be
        // reused within the grace, but only by a new process made leader of a group of its own
        // pid — the same pid the kernel would have to hand out again within two seconds.
        std::thread::spawn(move || {
            std::thread::sleep(GRACE);
            // Gone by now is the usual case, not an error.
            let _gone = killpg(pgid, Signal::SIGKILL);
        });
    }
}
