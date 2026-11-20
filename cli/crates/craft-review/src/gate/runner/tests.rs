use std::time::Duration;

use super::*;

fn runner(dir: &Path) -> Runner {
    Runner::new(Duration::from_secs(30), None, dir.join("out"))
}

/// The pid a tool left in `file`.
fn pid_in(file: &Path) -> i32 {
    std::fs::read_to_string(file)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Whether `pid` is gone: reparented and reaped by init once killed, looked for a little while.
fn gone(pid: i32) -> bool {
    (0..100).any(|_| {
        let gone = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err();
        if !gone {
            std::thread::sleep(Duration::from_millis(20));
        }
        gone
    })
}

#[test]
fn a_program_not_on_the_path_is_missing() {
    let d = tempfile::tempdir().unwrap();
    let ran = runner(d.path()).run(d.path(), "craft-no-such-tool", &[]);
    assert_eq!(ran, Ran::Missing);
}

#[test]
fn a_working_directory_that_is_gone_is_no_missing_program() {
    let d = tempfile::tempdir().unwrap();
    let gone = d.path().join("removed-worktree");
    let ran = runner(d.path()).run(&gone, "sh", &["-c", "true"]);
    let Ran::Broken(why) = ran else {
        panic!("{ran:?}");
    };
    assert!(why.contains("does not exist"), "{why}");
    assert!(why.contains("removed-worktree"), "{why}");
}

#[test]
fn a_stop_kills_the_running_tool_with_its_group_and_starts_no_other() {
    let d = tempfile::tempdir().unwrap();
    let cancel = crate::cancel::Cancel::default();
    let r = runner(d.path()).stopped_by(cancel.clone());
    let pid = d.path().join("child.pid");
    let script = format!("sleep 30 & echo $! > '{}'; wait", pid.display());
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        cancel.cancel();
    });
    let began = std::time::Instant::now();
    let ran = r.run(d.path(), "sh", &["-c", &script]);
    stopper.join().unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(ran, Ran::Broken(crate::cancel::STOPPED.into()));
    // The group's other member, the sleep, was killed with its leader.
    let pid = pid_in(&pid);
    assert!(gone(pid), "the tool's child {pid} outlived the stop");
    assert_eq!(
        r.run(d.path(), "sh", &["-c", "true"]),
        Ran::Broken(crate::cancel::STOPPED.into())
    );
}

#[test]
fn a_tool_that_exits_leaving_a_child_leaves_the_child_running() {
    // A server a tool starts for later (an sccache server through RUSTC_WRAPPER) is not the
    // gate's to kill once the tool exited: only a stop or the budget kills the group.
    let d = tempfile::tempdir().unwrap();
    let pid = d.path().join("child.pid");
    let script = format!(
        "sleep 30 >/dev/null 2>&1 & echo $! > '{}'; echo done",
        pid.display()
    );
    let ran = runner(d.path()).run(d.path(), "sh", &["-c", &script]);
    let pid = nix::unistd::Pid::from_raw(pid_in(&pid));
    // A kill is not seen at once: alive still after a while is alive.
    std::thread::sleep(Duration::from_millis(300));
    let alive = nix::sys::signal::kill(pid, None).is_ok();
    // Not left behind by the test, whatever the verdict.
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL).unwrap_or(());
    let Ran::Exited { ok: true, out, .. } = ran else {
        panic!("{ran:?}");
    };
    assert_eq!(out, "done\n");
    assert!(
        alive,
        "the tool's child {pid} was killed after the tool exited"
    );
}

#[test]
fn the_budget_kills_the_running_tool_with_its_group() {
    let d = tempfile::tempdir().unwrap();
    let pid = d.path().join("child.pid");
    let r = Runner::new(Duration::from_secs(1), None, d.path().join("out"));
    let script = format!("sleep 30 & echo $! > '{}'; wait", pid.display());
    let ran = r.run(d.path(), "sh", &["-c", &script]);
    assert!(matches!(ran, Ran::TimedOut(_)), "{ran:?}");
    let pid = pid_in(&pid);
    assert!(gone(pid), "the tool's child {pid} outlived the budget");
}

#[test]
fn a_tool_runs_with_the_no_prompt_environment() {
    if crate::cancel::caller_chooses_prompts("a_tool_runs_with_the_no_prompt_environment") {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let ran = runner(d.path()).run(d.path(), "env", &[]);
    let Ran::Exited { ok: true, out, .. } = ran else {
        panic!("{ran:?}");
    };
    for line in [
        "SSH_ASKPASS_REQUIRE=never",
        "GIT_ASKPASS=",
        "GIT_TERMINAL_PROMPT=0",
    ] {
        assert!(out.lines().any(|l| l == line), "{line} not in {out}");
    }
}
