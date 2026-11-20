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

/// Kills `child` and every process of its group (see [`detached`]), then reaps it.
pub fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        let group = nix::unistd::Pid::from_raw(pid);
        // The group may be gone already: nothing is left to kill then.
        nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL).unwrap_or(());
    }
    // Likewise the leader, which the group's kill may have reaped already.
    child.kill().unwrap_or(());
    if child.wait().is_err() {
        // Nothing is left to reap.
    }
}

#[cfg(test)]
mod tests;
