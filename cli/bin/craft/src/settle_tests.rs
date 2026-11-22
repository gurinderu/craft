use std::io;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{Exit, Job, on_thread};

fn refused(_job: Job) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::WouldBlock))
}

#[tokio::test]
async fn nothing_pending_starts_no_thread_and_settles_nothing() {
    Exit {
        pending: || false,
        settle: || panic!("settled with nothing pending"),
        spawn: |_job| panic!("a thread started with nothing pending"),
    }
    .wait()
    .await;
}

#[tokio::test]
async fn a_refused_thread_settles_on_this_one() {
    static SETTLED: AtomicUsize = AtomicUsize::new(0);
    Exit {
        pending: || true,
        settle: || {
            SETTLED.fetch_add(1, Ordering::SeqCst);
        },
        spawn: refused,
    }
    .wait()
    .await;
    assert_eq!(SETTLED.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_given_thread_settles_on_it_and_is_waited_for() {
    static ON: Mutex<Option<String>> = Mutex::new(None);
    Exit {
        pending: || true,
        settle: || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            *ON.lock().unwrap() = std::thread::current().name().map(str::to_owned);
        },
        spawn: on_thread,
    }
    .wait()
    .await;
    assert_eq!(ON.lock().unwrap().as_deref(), Some("craft-settle"));
}

#[tokio::test]
#[should_panic(expected = "settle broke")]
async fn a_panic_on_the_settle_thread_is_raised_after_the_wait() {
    Exit {
        pending: || true,
        settle: || panic!("settle broke"),
        spawn: on_thread,
    }
    .wait()
    .await;
}
