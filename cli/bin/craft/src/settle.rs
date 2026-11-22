//! The exit path's wait for the agents' stopped groups: off the runtime's threads when the OS
//! gives a thread, on this one when it does not, and nothing at all when no grace is running.

use std::io;

/// A job handed to a thread of its own.
pub(crate) type Job = Box<dyn FnOnce() + Send>;

/// Waits out every running grace when `pending`: `settle` on a thread `spawn` starts, so the
/// runtime keeps turning meanwhile, or on this one when the OS refuses the thread — exit then
/// neither panics nor leaves a group unkilled. Nothing pending starts no thread, so a command
/// that ran no agent cannot fail at exit on a thread it never needed.
pub(crate) async fn at_exit(
    pending: bool,
    settle: fn(),
    spawn: impl FnOnce(Job) -> io::Result<()>,
) {
    if !pending {
        return;
    }
    let (settled, done) = tokio::sync::oneshot::channel();
    let job: Job = Box::new(move || {
        settle();
        let _gone = settled.send(());
    });
    if spawn(job).is_err() {
        settle();
    } else {
        // A settle that panicked dropped its sender: nothing is left to wait for.
        let _settled = done.await;
    }
}

/// Starts `job` on a thread of its own, detached.
pub(crate) fn on_thread(job: Job) -> io::Result<()> {
    std::thread::Builder::new()
        .name("craft-settle".to_owned())
        .spawn(job)
        .map(drop)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{Job, at_exit, on_thread};

    #[tokio::test]
    async fn nothing_pending_starts_no_thread_and_settles_nothing() {
        fn settle() {
            panic!("settled with nothing pending");
        }
        at_exit(false, settle, |_job: Job| -> io::Result<()> {
            panic!("a thread started with nothing pending")
        })
        .await;
    }

    #[tokio::test]
    async fn a_refused_thread_settles_on_this_one() {
        static SETTLED: AtomicUsize = AtomicUsize::new(0);
        fn settle() {
            SETTLED.fetch_add(1, Ordering::SeqCst);
        }
        at_exit(true, settle, |_job: Job| {
            Err(io::Error::from(io::ErrorKind::WouldBlock))
        })
        .await;
        assert_eq!(SETTLED.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_given_thread_settles_and_is_waited_for() {
        static SETTLED: AtomicUsize = AtomicUsize::new(0);
        fn settle() {
            std::thread::sleep(std::time::Duration::from_millis(50));
            SETTLED.fetch_add(1, Ordering::SeqCst);
        }
        at_exit(true, settle, on_thread).await;
        assert_eq!(SETTLED.load(Ordering::SeqCst), 1);
    }
}
