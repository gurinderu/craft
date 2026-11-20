//! A stop asked of a start in flight (`craft review run` on a stopping signal): the gate's tools,
//! the sources' git and the consumers' name search each look at it as they wait, kill what they
//! started and run nothing more, so `start` returns soon after with what it had, saying so.

use std::process::{Child, Command};
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

/// `cmd` spawned as the leader of a process group of its own, so [`kill_group`] reaches what it
/// starts in turn.
pub(crate) fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    #[cfg(not(unix))]
    let _alone = cmd;
}

/// Kills `child` and every process of its group (see [`own_group`]), then reaps it.
pub(crate) fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        let group = nix::unistd::Pid::from_raw(pid);
        // The group may be gone already: nothing is left to kill then.
        nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL).unwrap_or(());
    }
    // Likewise the leader, which the group's kill may have reaped already.
    child.kill().unwrap_or(());
    if child.wait().is_err() {
        // Nothing is left to reap.
    }
}
