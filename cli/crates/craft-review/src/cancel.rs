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

/// Turns off the prompts git and ssh would still try with no terminal (realm @nick/craft, node
/// #545), keeping what the caller chose — on `cmd` or in craft's own environment — and blocking
/// only the implicit fallbacks:
/// - git's terminal prompt, always (`GIT_TERMINAL_PROMPT=0`);
/// - git's askpass, unless the caller names one (a CI token script): an empty `GIT_ASKPASS`
///   stops git's search before `core.askPass` and a desktop's `SSH_ASKPASS`, and git fails at once;
/// - ssh's askpass, unless the caller set its rule: `SSH_ASKPASS_REQUIRE=never`, read by OpenSSH
///   8.4 and later.
pub fn no_prompt(cmd: &mut Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    for (var, unless_chosen) in [("GIT_ASKPASS", ""), ("SSH_ASKPASS_REQUIRE", "never")] {
        let on_cmd = cmd
            .get_envs()
            .find(|(k, _)| *k == var)
            .map(|(_, v)| v.is_some());
        if !on_cmd.unwrap_or_else(|| std::env::var_os(var).is_some()) {
            cmd.env(var, unless_chosen);
        }
    }
}

/// `cmd` spawned detached and with no prompt (realm @nick/craft, node #545): the leader of a
/// session of its own — a process group of its own, so [`kill_group`] reaches what it starts in
/// turn, and no controlling terminal — with [`no_prompt`]'s environment. So neither git nor an
/// ssh it starts asks for a passphrase or a password on its own: on the terminal it would stop
/// (SIGTTIN) in a background group of the caller's session, and through a desktop's askpass
/// dialog it would wait, either until the timeout; here it fails at once, or asks the askpass
/// the caller named.
pub(crate) fn detached_no_prompt(cmd: &mut Command) {
    no_prompt(cmd);
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

/// Kills `child` and every process of its group (see [`detached_no_prompt`]), then reaps it.
pub(crate) fn kill_group(child: &mut Child) {
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

/// Whether the test process's own environment chooses git's askpass or ssh's askpass rule, so a
/// test of the defaults would see the caller's choice instead: said on stderr and skipped, except
/// under CI (`CI` set), where the defaults must be exercised and it fails.
#[cfg(test)]
pub(crate) fn caller_chooses_prompts(name: &str) -> bool {
    use std::io::Write;
    let chosen: Vec<&str> = ["GIT_ASKPASS", "SSH_ASKPASS_REQUIRE"]
        .into_iter()
        .filter(|v| std::env::var_os(v).is_some())
        .collect();
    if chosen.is_empty() {
        return false;
    }
    assert!(
        std::env::var_os("CI").is_none(),
        "{name}: {chosen:?} set under CI, the defaults unexercised"
    );
    let _noted = writeln!(
        std::io::stderr(),
        "{name}: skipped, {chosen:?} set in the test's own environment"
    );
    true
}

#[cfg(test)]
mod tests;
