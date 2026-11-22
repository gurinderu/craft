//! The unix side of [`super`]: SIGTERM to a stopped group, its grace, the SIGKILL after it.

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

/// The grace threads of stopped groups: those still inside their grace and those finished but not
/// yet joined, which the next stop prunes. [`settle_stops`](super::settle_stops) takes and joins
/// them all; [`pending`] counts only the running ones.
static STOPPING: Mutex<Vec<JoinHandle<()>>> = Mutex::new(Vec::new());

/// A grace, handed to a thread of its own.
pub(super) type Grace = Box<dyn FnOnce() + Send>;

pub(super) fn stop(pgid: Pid) {
    stop_with(pgid, |grace| {
        std::thread::Builder::new()
            .name("craft-grace".to_owned())
            .spawn(grace)
    });
}

/// Sends the group SIGTERM and starts its grace on the thread `spawn` gives, listed under the lock
/// in the same move, so a check or settle never runs between the two; the lock is held across the
/// spawn, which only the stops and the settle contend for. When the OS refuses the thread, this
/// drop runs the grace itself: it blocks its worker for at most the two seconds, only when threads
/// have run out, and the group still gets its grace and its SIGKILL within the same two seconds
/// the thread would have — nothing is kept by pid past them, so the reuse caveat below holds
/// either way. Not deferred to the settle: by then the pid could lead an unrelated group.
pub(super) fn stop_with(pgid: Pid, spawn: impl FnOnce(Grace) -> io::Result<JoinHandle<()>>) {
    // An error means the group is gone already (ESRCH): nothing to stop.
    if killpg(pgid, Signal::SIGTERM).is_err() {
        return;
    }
    let deadline = Instant::now() + GRACE;
    let mut stopping = STOPPING.lock().unwrap_or_else(PoisonError::into_inner);
    stopping.retain(|t| !t.is_finished());
    // Drop cannot wait; a thread finishes the job. The group id could in principle be reused
    // within the grace, but only by a new process made leader of a group of its own pid — the
    // same pid the kernel would have to hand out again within two seconds.
    if let Ok(thread) = spawn(Box::new(move || wait_out(pgid, deadline))) {
        stopping.push(thread);
    } else {
        drop(stopping);
        wait_out(pgid, deadline);
    }
}

/// Waits for the group to go until `deadline`, then sends SIGKILL to whatever is left and reaps
/// the killed leader.
fn wait_out(pgid: Pid, deadline: Instant) {
    while Instant::now() < deadline {
        // The leader is craft's own child, and until reaped it stays a zombie that still counts as
        // a member, so a group that obeyed SIGTERM would look alive for the whole grace: reap it
        // here. Nothing waits on it any more: the guard is dropped only with the future that owned
        // its tokio `Child`, which is then reaped already (ECHILD) when its run ended normally, or
        // held by tokio's orphan queue after a stop, which drops a child found gone. Reaping by
        // pid shares the reuse caveat above: only a new child of craft could take that pid within
        // the grace.
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
    // SIGKILL ends the leader at once: reaped here as in the grace, it is gone when this returns.
    // Not a blocking wait, for the reuse caveat: a new child of craft on that pid would hold it
    // for as long as it ran.
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
    running(&STOPPING.lock().unwrap_or_else(PoisonError::into_inner))
}

/// Whether any grace thread is still running; a finished one left unjoined is not.
pub(super) fn running(threads: &[JoinHandle<()>]) -> bool {
    threads.iter().any(|t| !t.is_finished())
}

pub(super) fn settle() {
    let stopping = std::mem::take(&mut *STOPPING.lock().unwrap_or_else(PoisonError::into_inner));
    for thread in stopping {
        // The thread only signals; a panic there leaves nothing more to do here.
        let _panicked = thread.join();
    }
}

/// How many grace threads are listed, finished or not.
#[cfg(test)]
pub(super) fn listed() -> usize {
    STOPPING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .len()
}
