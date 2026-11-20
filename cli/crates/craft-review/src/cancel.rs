//! A stop asked of a start in flight (`craft review run` on a stopping signal): the gate's tools,
//! the sources' git and the consumers' name search each look at it as they wait, kill what they
//! started and run nothing more, so `start` returns soon after with what it had, saying so.

use std::process::{Child, Command};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// What a part cut short by the stop says of itself.
pub const STOPPED: &str = "stopped with the run";

/// Shared between the one that stops and the parts that wait; cloned, one flag.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    /// Asks every part holding this flag to stop.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether a stop was asked.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The environment craft's own git runs with (realm @nick/craft, node #545), keeping what the
/// caller chose on `cmd` or in craft's own environment: git's terminal prompt off, always
/// (`GIT_TERMINAL_PROMPT=0`), and ssh's askpass off unless the caller set its rule
/// (`SSH_ASKPASS_REQUIRE=never`, read by OpenSSH 8.4 and later). Git's own askpass
/// (`GIT_ASKPASS`, `core.askPass`) is left alone, so a CI token script works: a desktop askpass
/// for an https remote may still ask — a known limit. For git only: a gate tool gets none of it.
pub fn no_prompt_env(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let on_cmd = cmd
        .get_envs()
        .find(|(k, _)| *k == "SSH_ASKPASS_REQUIRE")
        .map(|(_, v)| v.is_some());
    if !on_cmd.unwrap_or_else(|| std::env::var_os("SSH_ASKPASS_REQUIRE").is_some()) {
        cmd.env("SSH_ASKPASS_REQUIRE", "never");
    }
}

/// `cmd` spawned detached (realm @nick/craft, node #545): the leader of a session of its own — a
/// process group of its own, so [`kill_group`] reaches what it starts in turn, and no controlling
/// terminal, so nothing it starts asks on one: an ssh asking a passphrase on `/dev/tty` fails at
/// once, where in a background group of the caller's session it would stop (SIGTTIN) until the
/// timeout.
pub fn detached(cmd: &mut Command) {
    #[cfg(unix)]
    new_session(cmd);
    #[cfg(not(unix))]
    let _alone = cmd;
}

#[cfg(unix)]
#[expect(
    unsafe_code,
    reason = "a hook between fork and exec is unsafe; std's setsid is not stable"
)]
fn new_session(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the hook runs in the forked child before exec and only calls setsid(2), which is
    // async-signal-safe, allocates nothing and touches no lock.
    unsafe {
        cmd.pre_exec(|| {
            nix::unistd::setsid()
                .map(drop)
                .map_err(std::io::Error::from)
        });
    }
}

/// How long a stopped group has to exit on SIGTERM before SIGKILL.
#[cfg(unix)]
const GRACE: std::time::Duration = std::time::Duration::from_secs(1);

/// Kills `child` and every process of its group (see [`detached`]), then reaps it: SIGTERM first,
/// for git to remove the lock files it holds in the user's repository (the ref lock of a fetch
/// stopped while updating `origin/<branch>`), which SIGKILL leaves behind, so the next fetch
/// there fails on it; SIGKILL to what is left once the group is gone or [`GRACE`] runs out.
pub fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        stop_group(nix::unistd::Pid::from_raw(pid));
    }
    // Likewise the leader, which the group's kill may have reaped already.
    child.kill().unwrap_or(());
    if child.wait().is_err() {
        // Nothing is left to reap.
    }
}

/// The group's stop. The leader is not reaped here, so while it lives or is a zombie its id
/// names no other group; one reaped before (`hook/bounded.rs` waits for its exit, then for its
/// output) is signalled only while the group still has a member, a later one's id taken only
/// once it has none.
#[cfg(unix)]
fn stop_group(group: nix::unistd::Pid) {
    use nix::sys::signal::{Signal, killpg};
    // The group may be gone already: nothing is left to stop then.
    if killpg(group, Signal::SIGTERM).is_err() {
        return;
    }
    let deadline = std::time::Instant::now() + GRACE;
    while living(group) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if killpg(group, None).is_ok() {
        // What outlived the grace, or the leader's zombie.
        killpg(group, Signal::SIGKILL).unwrap_or(());
    }
}

/// Whether a process of `group` still runs, a zombie aside: read from `/proc` on Linux, where a
/// zombie leader is told apart; elsewhere any member counts, so an unreaped leader that exited
/// waits out the grace.
#[cfg(unix)]
fn living(group: nix::unistd::Pid) -> bool {
    #[cfg(target_os = "linux")]
    if let Ok(procs) = std::fs::read_dir("/proc") {
        let want = group.as_raw().to_string();
        return procs.flatten().any(|p| {
            std::fs::read_to_string(p.path().join("stat")).is_ok_and(|stat| {
                // `pid (comm) state ppid pgrp …`, the name may hold anything up to its last `)`.
                let mut rest = stat
                    .rsplit_once(')')
                    .map_or("", |(_, r)| r)
                    .split_whitespace();
                let state = rest.next();
                state.is_some_and(|s| s != "Z") && rest.nth(1) == Some(want.as_str())
            })
        });
    }
    nix::sys::signal::killpg(group, None).is_ok()
}

#[cfg(test)]
mod tests;
