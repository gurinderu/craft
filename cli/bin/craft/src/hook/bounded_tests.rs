use std::process::Command;
use std::time::{Duration, Instant};

use super::output;

#[test]
fn a_command_within_its_limit_answers() {
    let mut c = Command::new("sh");
    c.args(["-c", "echo out; echo err >&2; exit 3"]);
    let o = output(c, Duration::from_secs(5)).unwrap();
    assert_eq!(
        (o.status.code(), o.stdout.as_slice(), o.stderr.as_slice()),
        (Some(3), &b"out\n"[..], &b"err\n"[..])
    );
}

#[test]
fn a_command_past_its_limit_is_stopped_and_said() {
    let mut c = Command::new("sleep");
    c.arg("30");
    let began = Instant::now();
    let why = output(c, Duration::from_millis(300)).unwrap_err();
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert!(why.contains("did not answer within"), "{why}");
}

#[test]
fn a_missing_program_is_said() {
    let why = output(
        Command::new("craft-no-such-program"),
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert!(why.contains("not found"), "{why}");
}

#[test]
fn a_command_whose_child_holds_its_output_past_the_limit_is_said() {
    let mut c = Command::new("sh");
    c.args(["-c", "sleep 5 & echo out"]);
    let began = Instant::now();
    let why = output(c, Duration::from_secs(1)).unwrap_err();
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "{:?}",
        began.elapsed()
    );
    assert!(why.contains("did not answer within"), "{why}");
}
