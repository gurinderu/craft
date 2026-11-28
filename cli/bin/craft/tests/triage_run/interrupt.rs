use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::fixture::{Bench, read};

#[test]
fn sigterm_interrupts_ledger_stdin_before_start() {
    interrupt_stdin("--prior-ledger", "-TERM", 15);
}

#[test]
fn sigint_interrupts_ledger_stdin_before_start() {
    interrupt_stdin("--prior-ledger", "-INT", 2);
}

#[test]
fn sigterm_interrupts_decisions_stdin_before_start() {
    interrupt_stdin("--prior-decisions", "-TERM", 15);
}

#[test]
fn sigint_interrupts_decisions_stdin_before_start() {
    interrupt_stdin("--prior-decisions", "-INT", 2);
}

#[expect(clippy::unwrap_used, reason = "fixture failures must fail the test")]
fn interrupt_stdin(flag: &str, signal: &str, number: i32) {
    let b = Bench::new();
    let mut child = b
        .command("codex", "ok")
        .arg("--repo")
        .arg(b.path("repo"))
        .arg("--report")
        .arg(b.path("report.md"))
        .arg("--run-dir")
        .arg(b.path("run"))
        .args([flag, "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"[").unwrap();
    let bound = Instant::now() + Duration::from_secs(10);
    let reading = loop {
        if super::blocked::reading_stdin(child.id()) {
            break true;
        }
        if child.try_wait().unwrap().is_some() || Instant::now() >= bound {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let sent = reading
        && Command::new("kill")
            .args([signal, &child.id().to_string()])
            .status()
            .unwrap()
            .success();
    let bound = Instant::now() + Duration::from_secs(3);
    while child.try_wait().unwrap().is_none() && Instant::now() < bound {
        std::thread::sleep(Duration::from_millis(20));
    }
    let exited = child.try_wait().unwrap().is_some();
    if !exited {
        child.kill().unwrap();
    }
    // Keep the input pipe open until after observing the signal's effect.
    let out = child.wait_with_output().unwrap();
    assert!(reading, "{flag}: never blocked reading stdin: {out:?}");
    assert!(sent, "{flag}: failed to send {signal}");
    assert!(exited, "{flag}: still reading stdin after {signal}");
    assert_eq!(out.status.signal(), Some(number), "{out:?}");
    assert!(b.calls().is_empty(), "no host may run during input");
    assert!(!b.path("run").exists(), "no plan or state before start");
    assert!(b.index().is_empty(), "no record before start");
}

#[test]
fn a_signal_stops_the_host_group_without_filing_a_review_then_resumes() {
    for (signal, code) in [("-TERM", 143), ("-INT", 130)] {
        let b = Bench::new();
        let script = std::fs::read(b.path("host")).unwrap();
        crate::common::write_executable(&b.path("host"), "#!/bin/sh\ncat > /dev/null\nsleep 300 &\necho $! > \"$FIXTURE/grandchild\"\necho $$ > \"$FIXTURE/pid.tmp\"\nmv \"$FIXTURE/pid.tmp\" \"$FIXTURE/pid\"\nwait\n").unwrap();
        let mut child = b
            .command("codex", "ok")
            .arg("--repo")
            .arg(b.path("repo"))
            .arg("--report")
            .arg(b.path("report.md"))
            .arg("--run-dir")
            .arg(b.path("run"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let bound = Instant::now() + Duration::from_secs(15);
        while !b.path("pid").exists() && Instant::now() < bound {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = b.path("pid").exists();
        assert!(
            Command::new("kill")
                .args([signal, &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let bound = Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() && Instant::now() < bound {
            std::thread::sleep(Duration::from_millis(20));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(ready, "host never started");
        for file in ["pid", "grandchild"] {
            let pid = std::fs::read_to_string(b.path(file)).unwrap();
            let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim()));
            let gone = stat.map_or(true, |s| {
                s.rsplit(')').next().unwrap().trim_start().starts_with('Z')
            });
            if !gone {
                let _killed = Command::new("kill").args(["-KILL", pid.trim()]).status();
            }
            assert!(gone, "{file} outlived craft");
        }
        b.expect(&out, code);
        let hint = format!(
            "To resume it: `craft triage run --backend codex --run '{}'`.",
            b.path("run").display()
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains(&hint), "{stdout}");
        assert!(b.index().is_empty());
        assert!(!b.path("run/record.json").exists());
        assert_eq!(read(&b.path("run/state.json"))["tasks"][0]["retries"], 0);
        std::fs::write(b.path("host"), script).unwrap();
        b.expect(&b.resume("codex", "ok"), 0);
        assert_eq!(b.index().len(), 1);
    }
}
