//! git as the source preparation runs it (as the retired Node CLI ran it):
//! never prompting, never acting on a repository the caller's environment points at, each command
//! bounded in time and all of them by the preparation's budget, a failure one line.

use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cancel::{Cancel, STOPPED, detached_no_prompt, kill_group};

/// How long one git command may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the whole preparation may run: well under the 600 s the driver gives `review start`
/// (`lib/cli-review-steps.mjs`), so points past it are named and the review still starts.
const BUDGET: Duration = Duration::from_secs(240);
/// How long ssh waits to connect, unless the caller set its own command.
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

/// What a source whose git failed on the remote is told with: git asks nothing here unless the
/// caller named an askpass (`detached_no_prompt`), so its last line ("Could not read from remote
/// repository") is all it says of an authentication.
pub(super) const AUTH_HINT: &str = "craft runs git with no terminal or password prompt: an ssh key \
    with a passphrase must be in ssh-agent, https needs a credential helper or a token";

/// The failure of a command the budget cut, and of one it left no time for.
pub(super) const OUT_OF_BUDGET: &str = "the preparation's budget ran out";

/// git as the preparation runs it.
#[derive(Debug, Clone)]
pub struct Git {
    /// What the commands' environment adds to craft's own.
    pub env: Vec<(OsString, OsString)>,
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
    /// git that never prompts on its own — every command runs detached, with no prompt but an
    /// askpass the caller named (`detached_no_prompt`) — with batch mode and a connect timeout for
    /// ssh unless the caller set its own command (`gitEnv`).
    #[must_use]
    pub fn prompt_free() -> Self {
        let mut env = Vec::new();
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            env.push(("GIT_SSH_COMMAND".into(), SSH.into()));
        }
        Self {
            env,
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

    /// Runs `git args`, its stdout; why not, one line, on a failure or the timeout. The output
    /// is read once git exits: each command here prints a line or two, well under a pipe's
    /// buffer.
    pub(crate) fn run(&self, args: &[&str]) -> Result<String, String> {
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
        // Detached, with no prompt (realm @nick/craft, node #545): a stop or the timeout kills what
        // it runs too (ssh, a helper), and an ssh of the caller's own `GIT_SSH_COMMAND` (no batch
        // mode) or a remote that asks a password fails at once instead of waiting on a terminal or
        // a desktop's askpass, unless the caller named one; the report names the source with git's reason, a remote's failure with the hint
        // [`AUTH_HINT`].
        detached_no_prompt(&mut cmd);
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "git not found on PATH".to_owned()
                } else {
                    format!("git failed: {e}")
                }
            })?;
        let start = Instant::now();
        while child.try_wait().map_err(|e| e.to_string())?.is_none() {
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
        // What it left behind goes with it: a child still holding its output would keep the read
        // below open past the timeout and the stop.
        kill_group(&mut child);
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().map(str::trim).rfind(|l| !l.is_empty());
        Err(format!("git failed: {}", line.unwrap_or("no message"))
            .chars()
            .take(300)
            .collect())
    }

    /// Runs `git args` that reach the remote (`ls-remote`, `fetch`): a failure carries
    /// [`AUTH_HINT`], a timeout or a stop does not.
    pub(super) fn run_remote(&self, args: &[&str]) -> Result<String, String> {
        self.run(args).map_err(|e| {
            if e.starts_with("git failed: ") {
                format!("{e} — {AUTH_HINT}")
            } else {
                e
            }
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

#[cfg(test)]
mod askpass_tests;
#[cfg(test)]
mod env_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tty_tests;
