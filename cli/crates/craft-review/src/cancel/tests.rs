use std::ffi::OsStr;
use std::process::Command;

use super::no_prompt_env;

/// The value `cmd` sets `var` to, `None` when it sets none.
fn env_of<'a>(cmd: &'a Command, var: &str) -> Option<&'a OsStr> {
    cmd.get_envs().find(|(k, _)| *k == var).and_then(|(_, v)| v)
}

#[test]
fn the_callers_ssh_askpass_rule_is_kept_and_the_terminal_prompt_is_off() {
    let mut cmd = Command::new("git");
    cmd.env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_TERMINAL_PROMPT", "1");
    no_prompt_env(&mut cmd);
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("force"))
    );
    assert_eq!(env_of(&cmd, "GIT_TERMINAL_PROMPT"), Some(OsStr::new("0")));
}

#[test]
fn with_no_rule_of_the_callers_ssh_never_asks_and_git_askpass_is_left_alone() {
    let mut cmd = Command::new("git");
    cmd.env_remove("SSH_ASKPASS_REQUIRE")
        .env_remove("GIT_ASKPASS");
    no_prompt_env(&mut cmd);
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS_REQUIRE"),
        Some(OsStr::new("never"))
    );
    assert_eq!(env_of(&cmd, "GIT_ASKPASS"), None);
}

#[cfg(unix)]
fn git_in(dir: &std::path::Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A fetch stopped while it holds the lock of the ref it updates in the user's repository: a
/// `reference-transaction` hook holds it there, as a slow ref update would.
#[cfg(unix)]
#[test]
fn a_fetch_stopped_holding_a_ref_lock_leaves_no_lock_behind() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};
    let t = tempfile::tempdir().unwrap();
    let up = t.path().join("up");
    std::fs::create_dir(&up).unwrap();
    git_in(&up, &["init", "-q", "-b", "main"]);
    git_in(&up, &["commit", "-q", "--allow-empty", "-m", "one"]);
    git_in(t.path(), &["clone", "-q", "up", "r"]);
    git_in(&up, &["commit", "-q", "--allow-empty", "-m", "two"]);
    let hooks = t.path().join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\n[ \"$1\" = prepared ] && exec sleep 30\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let repo = t.path().join("r");
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&repo)
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.display()))
        .args([
            "fetch",
            "-q",
            "origin",
            "+refs/heads/main:refs/remotes/origin/main",
        ]);
    super::detached(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    let lock = repo.join(".git/refs/remotes/origin/main.lock");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !lock.exists() {
        assert!(Instant::now() < deadline, "the fetch never took the lock");
        std::thread::sleep(Duration::from_millis(20));
    }
    super::kill_group(&mut child);
    assert!(!lock.exists(), "the stop left {}", lock.display());
}

/// One that ignores the gentle stop is still killed, a grace later.
#[cfg(unix)]
#[test]
fn a_command_ignoring_the_gentle_stop_is_killed_after_the_grace() {
    use std::time::{Duration, Instant};
    let mut cmd = Command::new("sh");
    cmd.args(["-c", "trap '' TERM; sleep 30"]);
    super::detached(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let began = Instant::now();
    super::kill_group(&mut child);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert!(child.try_wait().unwrap().is_some());
}

/// The leader gone and reaped (`hook/bounded.rs` reads a command's output after its exit) while
/// what it started still runs: that one, stopping slowly, still gets its grace.
#[cfg(unix)]
#[test]
fn what_outlives_a_reaped_leader_gets_its_grace_too() {
    use std::time::{Duration, Instant};
    let t = tempfile::tempdir().unwrap();
    let lock = t.path().join("lock");
    let script = format!(
        "(trap 'sleep 0.3; rm -f {0}; exit 0' TERM; touch {0}; while :; do sleep 0.05; done) & exit 0",
        lock.display()
    );
    let mut cmd = Command::new("sh");
    cmd.args(["-c", &script]);
    super::detached(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    child.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !lock.exists() {
        assert!(Instant::now() < deadline, "the descendant never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    super::kill_group(&mut child);
    assert!(
        !lock.exists(),
        "the descendant was killed before it stopped"
    );
}
