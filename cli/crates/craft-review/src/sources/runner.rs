//! git as the source preparation runs it (as the retired Node CLI ran it):
//! never prompting, never acting on a repository the caller's environment points at, each command
//! bounded in time and all of them by the preparation's budget, a failure one line.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cancel::{Cancel, STOPPED, detached, kill_group, no_prompt_env};
use spool::Spool;

pub(crate) mod spool;

/// How long one git command may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the whole preparation may run: well under the 600 s the driver gives `review start`
/// (`lib/cli-review-steps.mjs`), so points past it are named and the review still starts.
const BUDGET: Duration = Duration::from_secs(240);
/// How long ssh waits to connect, unless the caller chose its own ssh ([`callers_ssh`]).
const SSH: &str = "ssh -o BatchMode=yes -o ConnectTimeout=20";
/// What locates a repository for git: set by a hook git runs, they would point a fetch or a
/// checkout at the reviewer's own repository (`git rev-parse --local-env-vars`, configuration
/// aside, which the caller may set on purpose).
const REPO_VARS: [&str; 14] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_GRAFT_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_NAMESPACE",
    "GIT_INTERNAL_SUPER_PREFIX",
];

/// What a source whose git failed on the remote is told with: git asks on no terminal here and
/// ssh through no askpass the caller did not choose (`no_prompt_env`, `detached`), so git's last
/// line ("Could not read from remote repository") is all it says of an access failure.
pub(crate) const AUTH_HINT: &str = "if this is an access failure: craft runs git with no terminal \
    prompt, so an ssh key with a passphrase must be in ssh-agent, and https needs a credential \
    helper, a token or an askpass of your own";

/// The failure of a command the budget cut, and of one it left no time for.
pub(super) const OUT_OF_BUDGET: &str = "the preparation's budget ran out";

/// Why git's output could not be kept or read, one line.
fn kept(e: &std::io::Error) -> String {
    format!("git's output could not be kept: {e}")
}

/// Whether a git command reaches the remote: its failure then says git asks for no credentials.
/// `Lazy` is a local command that may fetch a partial clone's missing objects: its failure says
/// so only when that fetch is what failed.
#[derive(Debug, Clone, Copy)]
enum Call {
    Local,
    Remote,
    Lazy,
}

/// git as the preparation runs it.
#[derive(Debug, Clone)]
pub struct Git {
    /// What the commands' environment adds to craft's own.
    pub env: Vec<(OsString, OsString)>,
    /// What the commands' environment takes out of craft's own.
    pub unset: Vec<OsString>,
    /// How long one command may run.
    pub timeout: Duration,
    /// How long the whole preparation may run.
    pub budget: Duration,
    /// When the budget runs out, once a preparation started.
    pub(super) deadline: Option<Instant>,
    /// A stop asked of the run: the command running is killed with what it started (its process
    /// group) and no other starts.
    pub(super) cancel: Cancel,
}

impl Git {
    /// git that never prompts on a terminal — every command runs detached, with craft's no-prompt
    /// environment (`detached`, `no_prompt_env`) — with batch mode and a connect timeout for ssh
    /// unless the caller chose its own ssh ([`callers_ssh`]), for commands run in a temporary
    /// directory as the sources' are.
    #[must_use]
    pub fn prompt_free() -> Self {
        Self::prompt_free_in(&std::env::temp_dir())
    }

    /// [`Git::prompt_free`] for commands run in `dir`.
    #[must_use]
    pub fn prompt_free_in(dir: &Path) -> Self {
        let mut env = Vec::new();
        if !callers_ssh(dir, |v| std::env::var_os(v).is_some()) {
            env.push(("GIT_SSH_COMMAND".into(), SSH.into()));
        }
        Self {
            env,
            unset: Vec::new(),
            timeout: GIT_TIMEOUT,
            budget: BUDGET,
            deadline: None,
            cancel: Cancel::default(),
        }
    }

    /// This git, its commands stopped once `cancel` is.
    #[must_use]
    pub fn stopped_by(&self, cancel: Cancel) -> Self {
        Self {
            cancel,
            ..self.clone()
        }
    }

    /// This git with its budget starting now.
    pub(super) fn budgeted(&self) -> Self {
        Self {
            deadline: Some(Instant::now() + self.budget),
            ..self.clone()
        }
    }

    /// How long the next command may run, and whether the budget is what bounds it.
    fn limit(&self) -> (Duration, bool) {
        match self.deadline {
            Some(d) if d.saturating_duration_since(Instant::now()) < self.timeout => {
                (d.saturating_duration_since(Instant::now()), true)
            }
            Some(_) | None => (self.timeout, false),
        }
    }

    /// Runs `git args` on this side only (`init`, `checkout`), its stdout; why not, one line, on a
    /// failure or the timeout.
    pub(crate) fn run(&self, args: &[&str]) -> Result<String, String> {
        self.call(args, Call::Local)
    }

    /// Runs `git args` that reach the remote (`ls-remote`, `fetch`), its stdout; why not, one
    /// line — git's own failure followed by [`AUTH_HINT`], a timeout, a stop or a git that would
    /// not start without it.
    pub(crate) fn run_remote(&self, args: &[&str]) -> Result<String, String> {
        self.call(args, Call::Remote)
    }

    /// Runs `git args` on this side that may fetch the objects a partial clone lacks from its
    /// promisor remote (`worktree add`, a `diff`), its stdout; why not, one line, with
    /// [`AUTH_HINT`] only when that fetch is what failed.
    pub(crate) fn run_lazy(&self, args: &[&str]) -> Result<String, String> {
        self.call(args, Call::Lazy)
    }

    /// Runs `git args` as `call` says. Its output goes to files ([`Spool`]) read once git exits,
    /// so nothing it left running holds the read past the timeout or the stop.
    fn call(&self, args: &[&str], call: Call) -> Result<String, String> {
        if self.cancel.is_cancelled() {
            return Err(STOPPED.into());
        }
        let (limit, budget) = self.limit();
        if limit.is_zero() {
            return Err(OUT_OF_BUDGET.into());
        }
        let mut cmd = Command::new("git");
        cmd.args(args).envs(self.env.iter().map(|(k, v)| (k, v)));
        for v in REPO_VARS {
            cmd.env_remove(v);
        }
        for v in &self.unset {
            cmd.env_remove(v);
        }
        // Detached, with no prompt (realm @nick/craft, node #545): a stop or the timeout kills what
        // it runs too (ssh, a helper), and an ssh of the caller's own `GIT_SSH_COMMAND` (no batch
        // mode) that asks a passphrase fails at once instead of waiting on a terminal or an ssh
        // askpass the caller did not choose; the report names the source with git's reason, a
        // remote's failure with the hint [`AUTH_HINT`].
        no_prompt_env(&mut cmd);
        detached(&mut cmd);
        let (mut out, to_out) = Spool::new().map_err(|e| kept(&e))?;
        let (mut err, to_err) = Spool::new().map_err(|e| kept(&e))?;
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(to_out)
            .stderr(to_err)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "git not found on PATH".to_owned()
                } else {
                    format!("git failed: {e}")
                }
            })?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(e) => {
                    kill_group(&mut child);
                    return Err(e.to_string());
                }
            }
            if self.cancel.is_cancelled() {
                kill_group(&mut child);
                return Err(STOPPED.into());
            }
            if start.elapsed() > limit {
                kill_group(&mut child);
                return Err(if budget {
                    OUT_OF_BUDGET.into()
                } else {
                    format!("git timed out after {}s", limit.as_secs())
                });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            return out.text().map_err(|e| kept(&e));
        }
        let err = err.text().map_err(|e| kept(&e))?;
        let line = err.lines().map(str::trim).rfind(|l| !l.is_empty());
        let failed: String = format!("git failed: {}", line.unwrap_or("no message"))
            .chars()
            .take(300)
            .collect();
        let remote = match call {
            Call::Local => false,
            Call::Remote => true,
            Call::Lazy => err.contains("promisor remote"),
        };
        Err(if remote {
            format!("{failed} — {AUTH_HINT}")
        } else {
            failed
        })
    }

    /// Whether the remote lists the tag `rev`.
    pub(super) fn lists_tag(&self, url: &str, rev: &str) -> Result<bool, String> {
        let want = format!("refs/tags/{rev}");
        let listed = self.run_remote(&["ls-remote", "--tags", "--", url, &want])?;
        Ok(listed
            .lines()
            .any(|l| l.split('\t').nth(1) == Some(want.as_str())))
    }
}

/// Whether the caller chose the ssh git runs in `dir`: `GIT_SSH_COMMAND` or `GIT_SSH` in the
/// environment (`is_set` asks it), or `core.sshCommand` in the configuration git reads there —
/// the system's and the user's, and the repository's when `dir` is one. A sources clone runs in a
/// temporary directory, so only the first two count for it.
fn callers_ssh(dir: &Path, is_set: impl Fn(&str) -> bool) -> bool {
    if is_set("GIT_SSH_COMMAND") || is_set("GIT_SSH") {
        return true;
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["config", "--get", "core.sshCommand"]);
    for v in REPO_VARS {
        cmd.env_remove(v);
    }
    cmd.stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
}

#[cfg(test)]
mod askpass_tests;
#[cfg(test)]
mod env_tests;
#[cfg(test)]
mod ssh_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tty_tests;
