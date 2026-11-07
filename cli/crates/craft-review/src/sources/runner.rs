//! git as the source preparation runs it (`execGit` and `gitEnv` in `lib/source-checkout.mjs`):
//! never prompting, each command bounded in time, its failure one line.

use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long one git command may run.
const GIT_TIMEOUT: Duration = Duration::from_secs(300);

/// git as the preparation runs it: never prompting, each command bounded in time.
#[derive(Debug, Clone)]
pub struct Git {
    /// What the commands' environment adds to craft's own.
    pub env: Vec<(OsString, OsString)>,
    pub timeout: Duration,
}

impl Git {
    /// git that never prompts: no terminal for https, batch mode for ssh unless the caller set its
    /// own command (`gitEnv`).
    #[must_use]
    pub fn prompt_free() -> Self {
        let mut env = vec![("GIT_TERMINAL_PROMPT".into(), "0".into())];
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            env.push(("GIT_SSH_COMMAND".into(), "ssh -o BatchMode=yes".into()));
        }
        Self {
            env,
            timeout: GIT_TIMEOUT,
        }
    }

    /// Runs `git args`, its stdout; why not, one line, on a failure or the timeout. The output
    /// is read once git exits: each command here prints a line or two, well under a pipe's
    /// buffer.
    pub(super) fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut child = Command::new("git")
            .args(args)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
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
            if start.elapsed() > self.timeout {
                child.kill().map_err(|e| e.to_string())?;
                child.wait().map_err(|e| e.to_string())?;
                return Err(format!("git timed out after {}s", self.timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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

    /// Whether the remote lists the tag `rev`.
    pub(super) fn lists_tag(&self, url: &str, rev: &str) -> Result<bool, String> {
        let want = format!("refs/tags/{rev}");
        let listed = self.run(&["ls-remote", "--tags", "--", url, &want])?;
        Ok(listed
            .lines()
            .any(|l| l.split('\t').nth(1) == Some(want.as_str())))
    }
}
