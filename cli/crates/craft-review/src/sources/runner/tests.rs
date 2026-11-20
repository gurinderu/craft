use std::path::Path;
use std::time::{Duration, Instant};

use super::Git;
use crate::cancel::{Cancel, STOPPED};

/// Gone, or a zombie (killed, not yet reaped); on a system without `/proc`, taken as gone.
fn gone(pid: &str) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| {
        s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    })
}

/// The pid `git` left in `file`, once it is there.
fn pid_in(file: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::read_to_string(file) {
            Ok(s) if s.ends_with('\n') => return s.trim().to_owned(),
            _ => assert!(Instant::now() < deadline, "no pid in {}", file.display()),
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_stop_kills_the_running_git_and_its_children_and_starts_no_other() {
    let tmp = tempfile::tempdir().unwrap();
    let pid = tmp.path().join("pid");
    let cancel = Cancel::default();
    let git = Git::prompt_free().stopped_by(cancel.clone());
    let watched = pid.clone();
    let stopper = std::thread::spawn(move || {
        let child = pid_in(&watched);
        cancel.cancel();
        child
    });
    let began = Instant::now();
    // git runs the alias through a shell, whose `sleep` is git's grandchild.
    let alias = format!(
        "alias.slow=!sh -c 'echo $$ > {}; exec sleep 30'",
        pid.display()
    );
    let ran = git.run(&["-c", &alias, "slow"]);
    let child = stopper.join().unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(ran, Err(STOPPED.to_owned()));
    assert_eq!(git.run(&["--version"]), Err(STOPPED.to_owned()));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !gone(&child) {
        if Instant::now() >= deadline {
            // Not left behind by the test, whatever the verdict.
            let _killed = std::process::Command::new("kill")
                .args(["-KILL", &child])
                .status();
            panic!("git's child {child} outlived the stop");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Kills `pid`, a process a test left running, whatever the verdict.
fn reap(pid: &str) {
    let _killed = std::process::Command::new("kill")
        .args(["-KILL", pid])
        .status();
}

#[test]
#[cfg(target_os = "linux")]
fn a_git_whose_detached_grandchild_holds_its_output_returns_at_once_and_a_stop_still_counts() {
    let tmp = tempfile::tempdir().unwrap();
    let pid = tmp.path().join("pid");
    // `setsid` takes the sleep out of git's group and session, still holding git's output.
    let leave = format!(
        "alias.leave=!sh -c 'setsid sleep 20 & echo $! > {}; echo done'",
        pid.display()
    );
    let began = Instant::now();
    let ran = Git::prompt_free().run(&["-c", &leave, "leave"]);
    reap(&pid_in(&pid));
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(ran, Ok("done\n".to_owned()));
    std::fs::remove_file(&pid).unwrap();
    let cancel = Cancel::default();
    let git = Git::prompt_free().stopped_by(cancel.clone());
    let watched = pid.clone();
    let stopper = std::thread::spawn(move || {
        let left = pid_in(&watched);
        cancel.cancel();
        left
    });
    let hold = format!(
        "alias.hold=!sh -c 'setsid sleep 20 & echo $! > {}; exec sleep 30'",
        pid.display()
    );
    let began = Instant::now();
    let ran = git.run(&["-c", &hold, "hold"]);
    reap(&stopper.join().unwrap());
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(ran, Err(STOPPED.to_owned()));
}

#[test]
fn a_child_git_leaves_in_its_group_after_a_normal_exit_is_left_running() {
    // A daemon git starts for later (a credential cache) is not the preparation's to kill.
    let tmp = tempfile::tempdir().unwrap();
    let pid = tmp.path().join("pid");
    let alias = format!(
        "alias.leave=!sh -c 'sleep 30 >/dev/null 2>&1 & echo $! > {}; echo done'",
        pid.display()
    );
    let ran = Git::prompt_free().run(&["-c", &alias, "leave"]);
    let child = pid_in(&pid);
    // A kill is not seen at once: alive still after a while is alive.
    std::thread::sleep(Duration::from_millis(300));
    let alive = !gone(&child);
    reap(&child);
    assert_eq!(ran, Ok("done\n".to_owned()));
    assert!(alive, "git's child {child} was killed after git exited");
}

#[test]
fn the_timeout_kills_the_running_git_and_its_children() {
    let tmp = tempfile::tempdir().unwrap();
    let pid = tmp.path().join("pid");
    let mut git = Git::prompt_free();
    git.timeout = Duration::from_secs(1);
    let alias = format!(
        "alias.slow=!sh -c 'echo $$ > {}; exec sleep 30'",
        pid.display()
    );
    let ran = git.run(&["-c", &alias, "slow"]);
    assert_eq!(ran, Err("git timed out after 1s".to_owned()));
    let child = pid_in(&pid);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !gone(&child) {
        assert!(
            Instant::now() < deadline,
            "git's child {child} outlived the timeout"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_remote_calls_timeout_stop_and_missing_git_carry_no_hint() {
    let mut git = Git::prompt_free();
    git.timeout = Duration::from_secs(1);
    let slow = "alias.slow=!sh -c 'exec sleep 30'";
    assert_eq!(
        git.run_remote(&["-c", slow, "slow"]),
        Err("git timed out after 1s".to_owned())
    );
    let mut nowhere = Git::prompt_free();
    nowhere.env.push(("PATH".into(), "/nonexistent".into()));
    assert_eq!(
        nowhere.run_remote(&["--version"]),
        Err("git not found on PATH".to_owned())
    );
    let cancel = Cancel::default();
    cancel.cancel();
    assert_eq!(
        Git::prompt_free()
            .stopped_by(cancel)
            .run_remote(&["--version"]),
        Err(STOPPED.to_owned())
    );
}
