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

#[test]
fn a_detached_command_past_its_limit_is_stopped_with_its_group() {
    let d = tempfile::tempdir().unwrap();
    let pid = d.path().join("pid");
    let mut c = Command::new("sh");
    c.args([
        "-c",
        &format!("sleep 30 & echo $! > '{}'; wait", pid.display()),
    ]);
    craft_review::cancel::detached(&mut c);
    let why = output(c, Duration::from_millis(500)).unwrap_err();
    assert!(why.contains("did not answer within"), "{why}");
    let child = std::fs::read_to_string(&pid).unwrap();
    let child = child.trim();
    // Reparented and reaped once killed: looked for a little while.
    let gone = (0..100).any(|_| {
        let alive = std::path::Path::new(&format!("/proc/{child}")).exists()
            && !std::fs::read_to_string(format!("/proc/{child}/stat"))
                .unwrap_or_default()
                .rsplit(')')
                .next()
                .is_some_and(|r| r.trim_start().starts_with('Z'));
        if alive {
            std::thread::sleep(Duration::from_millis(20));
        }
        !alive
    });
    if !gone {
        let _killed = Command::new("kill").args(["-KILL", child]).status();
    }
    assert!(gone, "the command's child {child} outlived its limit");
}
