//! The triage's end with a stderr nobody reads (realm @nick/craft, node #690): the review's
//! bounded end, in the time it ends by and in what it leaves on stdout.

use std::process::Stdio;
use std::time::Duration;

use super::fixture::{Bench, no_event};
use super::pipes::{drained, full_stderr, settled};

#[test]
fn an_unread_stderr_does_not_hang_the_triage() {
    let b = Bench::new();
    let (_unread, stderr) = full_stderr();
    let mut child = b
        .delegated("opencode", "ok")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .unwrap();
    let answer = drained(child.stdout.take().unwrap());
    // Time for the triage to come up and hand out its first task, so that the input closes on a
    // task in flight. Nothing here sees that it was handed out — its event is in the stderr
    // nobody reads — and a first hand-out after the closing fails with the same answer.
    std::thread::sleep(Duration::from_millis(1500));
    drop(child.stdin.take());
    let status = settled("the triage", &mut child, Duration::from_secs(20));
    let answer = answer.join().unwrap();
    assert_eq!(status.code(), Some(1), "{status}\n{answer}");
    assert!(answer.contains("Triage incomplete"), "{answer}");
    assert!(answer.contains("its input to craft ended"), "{answer}");
    // The stream has the one writer: nothing of it reaches the answer (realm @nick/craft, node
    // #690).
    no_event("stdout", &answer);
}
