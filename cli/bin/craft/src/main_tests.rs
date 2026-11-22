use std::io;
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::finish_with;
use crate::settle::{EXIT, Exit};

/// Refused a thread, `finish` settles on its own and still exits with the outcome's code.
#[tokio::test]
async fn finish_settles_inline_when_the_os_refuses_a_thread() {
    static SPAWNS: AtomicUsize = AtomicUsize::new(0);
    static SETTLED: AtomicUsize = AtomicUsize::new(0);
    let exit = Exit {
        pending: || true,
        settle: || {
            SETTLED.fetch_add(1, Ordering::SeqCst);
        },
        spawn: |_job| {
            SPAWNS.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::from(io::ErrorKind::WouldBlock))
        },
    };
    let code = finish_with(Ok(ExitCode::from(3)), &exit).await;
    assert_eq!(code, ExitCode::from(3));
    assert_eq!(
        (
            SPAWNS.load(Ordering::SeqCst),
            SETTLED.load(Ordering::SeqCst)
        ),
        (1, 1)
    );
}

/// craft's own exit starts the settle on a thread of its own, the one it names.
#[tokio::test]
async fn finish_settles_on_craft_s_own_settle_thread() {
    static ON: Mutex<Option<String>> = Mutex::new(None);
    let exit = Exit {
        pending: || true,
        settle: || *ON.lock().unwrap() = std::thread::current().name().map(str::to_owned),
        spawn: EXIT.spawn,
    };
    let _code = finish_with(Ok(ExitCode::SUCCESS), &exit).await;
    assert_eq!(ON.lock().unwrap().as_deref(), Some("craft-settle"));
}
