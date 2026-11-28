//! A run's streams for the probes of a stderr nobody reads, on Linux (realm @nick/craft, node
//! #690): a stderr full before the run starts, a child's stream read to its end on a thread of
//! its own, and a child's end awaited within a bound — so a run that hangs fails its test there
//! instead of hanging it. One file for the review's and the triage's tests, each including it by
//! `#[path]`; its caller keeps it to Linux.
#![expect(
    clippy::unwrap_used,
    reason = "the test's helpers fail the test loudly, like the tests they serve"
)]

use std::io::{Read, Write};
use std::process::{Child, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{FcntlArg, fcntl};

/// A stderr nobody reads: a pipe of one page, filled before the run starts, so a write to it
/// waits. Its read end stays open with the caller — closed, the writes would fail, not wait.
pub fn full_stderr() -> (std::io::PipeReader, Stdio) {
    let (read, mut write) = std::io::pipe().unwrap();
    fcntl(&write, FcntlArg::F_SETPIPE_SZ(4096)).unwrap();
    let capacity = usize::try_from(fcntl(&write, FcntlArg::F_GETPIPE_SZ).unwrap()).unwrap();
    write.write_all(&vec![b' '; capacity]).unwrap();
    (read, Stdio::from(write))
}

/// What `out` says to its end, read on a thread of its own so nothing waits on it.
pub fn drained(mut out: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        out.read_to_string(&mut text).unwrap();
        text
    })
}

/// The child's status once it ends on its own within `within`; one still running is killed, then
/// failed on.
pub fn settled(what: &str, child: &mut Child, within: Duration) -> ExitStatus {
    let deadline = Instant::now() + within;
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let outlived = child.try_wait().unwrap().is_none();
    if outlived {
        // Not left behind by the test, whatever its verdict.
        let _killed = child.kill();
    }
    let status = child.wait().unwrap();
    assert!(!outlived, "{what} did not end within {within:?}: {status}");
    status
}
