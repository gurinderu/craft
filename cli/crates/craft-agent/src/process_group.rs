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

/// Whether a group a guard stopped is still inside its grace: its thread has neither seen the group
/// gone nor sent SIGKILL yet, so [`settle_stops`] would wait for it. A stop whose grace has ended
/// is not counted, settled or not; nothing stopped, as in every command that runs no agent, is
/// false. Always false off unix.
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
    use std::sync::{Mutex, PoisonError};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::sys::wait::{WaitPidFlag, waitpid};
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
            let _gone = killpg(pgid, Signal::SIGKILL);
        });
        let mut stopping = STOPPING.lock().unwrap_or_else(PoisonError::into_inner);
        stopping.retain(|t| !t.is_finished());
        stopping.push(thread);
    }

    pub(super) fn pending() -> bool {
        running(&STOPPING.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// Whether any grace thread is still running; a finished one left unjoined is not.
    pub(super) fn running(threads: &[JoinHandle<()>]) -> bool {
        threads.iter().any(|t| !t.is_finished())
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

#[cfg(all(test, unix))]
mod tests {
    use std::io::Read as _;
    use std::os::unix::process::CommandExt;

    use super::{GroupGuard, settle_stops, stops_pending};

    /// A stopped group is pending while inside its grace, so the exit path that checks first still
    /// waits it out. The group ignores SIGTERM, so its grace runs whole and no other test's stop
    /// can prune it as finished before the check.
    #[test]
    fn a_stopped_group_inside_its_grace_is_pending() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; echo ready; exec sleep 10"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        // Stopped only once the trap is set, or SIGTERM could end it before it ignores it.
        let mut ready = [0; 6];
        child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
        drop(GroupGuard::new(Some(child.id())));
        assert!(stops_pending());
        settle_stops();
        // The grace ended in SIGKILL, which its thread does not reap: the killed child is reaped
        // here.
        let _reaped = child.wait();
    }

    /// Only a grace still running counts: a thread that finished but was never joined does not,
    /// so a stop that is over leaves nothing for the exit path to wait on.
    #[test]
    fn a_finished_grace_left_unjoined_is_not_running() {
        let finished = std::thread::spawn(|| {});
        while !finished.is_finished() {
            std::thread::yield_now();
        }
        let (release, held) = std::sync::mpsc::channel::<()>();
        let holding = std::thread::spawn(move || {
            let _released = held.recv();
        });
        let mut threads = vec![finished];
        assert!(!super::unix::running(&threads));
        threads.push(holding);
        assert!(super::unix::running(&threads));
        release.send(()).unwrap();
        for thread in threads {
            thread.join().unwrap();
        }
    }
}
