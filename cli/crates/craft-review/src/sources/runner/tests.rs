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
