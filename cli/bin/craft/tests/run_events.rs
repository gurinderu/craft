//! `craft review run --events json --delegate` end to end, the binary itself run (realm
//! @nick/craft, node #686): the events on stderr and the answer on stdout, with a stderr nobody
//! reads (realm @nick/craft, node #690) and with one that is read.
#![cfg(target_os = "linux")]
#![expect(
    clippy::unwrap_used,
    reason = "the test's helpers fail the test loudly, like the tests they serve"
)]

#[path = "run_interrupt/fixture.rs"]
mod fixture;

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use fixture::Bench;
use nix::fcntl::{FcntlArg, fcntl};
use serde_json::Value;

/// `craft review run --delegate` over the repository, its events on stderr and stdin left for the
/// test to take: the delegating process's end of the replies. No `opencode` runs.
fn delegated(bench: &Bench) -> Command {
    let mut cmd = bench.command("opencode", false);
    cmd.args(["--delegate", "--agents", "review-task", "--events", "json"]);
    cmd
}

/// A stderr nobody reads: a pipe of one page, filled before the run starts, so a write to it
/// waits. Its read end stays open with the caller — closed, the writes would fail, not wait.
fn full_stderr() -> (std::io::PipeReader, Stdio) {
    let (read, mut write) = std::io::pipe().unwrap();
    fcntl(&write, FcntlArg::F_SETPIPE_SZ(4096)).unwrap();
    let capacity = usize::try_from(fcntl(&write, FcntlArg::F_GETPIPE_SZ).unwrap()).unwrap();
    write.write_all(&vec![b' '; capacity]).unwrap();
    (read, Stdio::from(write))
}

/// What `out` says to its end, read on a thread of its own so nothing waits on it.
fn drained(mut out: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        out.read_to_string(&mut text).unwrap();
        text
    })
}

/// The child's status once it ends on its own within `within`; one still running is killed, then
/// failed on.
fn settled(what: &str, child: &mut Child, within: Duration) -> ExitStatus {
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

/// The kinds of each event on `stderr`, each one whole JSON line, up to and including the result,
/// which is returned; `end_input` runs under each task.
fn events_up_to_the_result(
    stderr: &mut impl BufRead,
    mut end_input: impl FnMut(),
) -> (Vec<String>, Value) {
    let (mut line, mut kinds) = (String::new(), Vec::new());
    loop {
        line.clear();
        assert!(
            stderr.read_line(&mut line).unwrap() != 0,
            "the stream ended before the result: {kinds:?}"
        );
        let event: Value = serde_json::from_str(&line).unwrap();
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned();
        let last = kind == "result";
        if kind == "task" {
            end_input();
        }
        kinds.push(kind);
        if last {
            return (kinds, event);
        }
    }
}

#[test]
fn an_unread_stderr_does_not_hang_the_run() {
    let bench = Bench::new();
    let (_unread, stderr) = full_stderr();
    let mut child = delegated(&bench)
        .stdin(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .unwrap();
    let answer = drained(child.stdout.take().unwrap());
    // Time for the run to come up and hand out its first task, so that the input closes on a
    // task in flight. Nothing here sees that it was handed out — its event is in the stderr
    // nobody reads — and a first hand-out after the closing fails with the same answer.
    std::thread::sleep(Duration::from_millis(1500));
    drop(child.stdin.take());
    let status = settled("the run", &mut child, Duration::from_secs(20));
    let answer = answer.join().unwrap();
    assert_eq!(status.code(), Some(1), "{status}\n{answer}");
    assert!(answer.contains("INCOMPLETE"), "{answer}");
    assert!(answer.contains("its input to craft ended"), "{answer}");
}

#[test]
fn a_reading_host_sees_every_event_whole_up_to_the_result() {
    let bench = Bench::new();
    let mut child = delegated(&bench).stdin(Stdio::piped()).spawn().unwrap();
    let answer = drained(child.stdout.take().unwrap());
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let (kinds, result) = events_up_to_the_result(&mut stderr, || drop(child.stdin.take()));
    let mut rest = String::new();
    stderr.read_to_string(&mut rest).unwrap();
    let output = child.wait_with_output().unwrap();
    let answer = answer.join().unwrap();
    assert!(rest.is_empty(), "the result is the last event: {rest:?}");
    assert_eq!(result["verdict"], "INCOMPLETE", "{result}");
    assert_eq!(result["exit_code"], 1, "{result}");
    let status = output.status;
    assert!(kinds.contains(&"log".to_owned()), "{kinds:?}");
    assert!(kinds.contains(&"task".to_owned()), "{kinds:?}");
    assert_eq!(status.code(), Some(1), "{status}\n{answer}");
    assert!(answer.contains("INCOMPLETE"), "{answer}");
    // The stream has the one writer: nothing of it reaches the answer (realm @nick/craft, node
    // #690).
    let event = answer.lines().find(|line| {
        serde_json::from_str::<Value>(line).is_ok_and(|event| !event["type"].is_null())
    });
    assert!(event.is_none(), "an event on stdout: {event:?}");
}
