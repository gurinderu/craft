//! A gate tool as the binary runs it: in its own process group, its output in files of the run's
//! `gate/` directory (a lint run prints megabytes, past a pipe's buffer), every command bounded by
//! what is left of the gate's one budget — a command the budget cuts is killed with its group and
//! reads as an unestablished signal, never a failure (`GATE_TIME_BUDGET`).

use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How often a running tool is checked for having exited.
const POLL: Duration = Duration::from_millis(50);

/// What running a tool came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Ran {
    /// It exited: its status (`None` killed by a signal), its stdout and its stderr.
    Exited {
        ok: bool,
        out: String,
        err: String,
    },
    /// No such program on the PATH.
    Missing,
    /// The budget ran out before it exited: after how long it ran.
    TimedOut(Duration),
    /// It could not be started or its output read.
    Broken(String),
}

/// The tools of one gate: where they run from and until when.
#[derive(Debug)]
pub(super) struct Runner {
    deadline: Instant,
    /// The PATH the tools are looked up on, when not craft's own.
    path: Option<OsString>,
    dir: PathBuf,
    count: std::cell::Cell<usize>,
}

impl Runner {
    pub(super) fn new(budget: Duration, path: Option<OsString>, dir: PathBuf) -> Self {
        Self {
            deadline: Instant::now() + budget,
            path,
            dir,
            count: std::cell::Cell::new(0),
        }
    }

    /// What is left of the budget.
    pub(super) fn left(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// Runs `program args` in `cwd` within what is left of the budget.
    pub(super) fn run(&self, cwd: &Path, program: &str, args: &[&str]) -> Ran {
        let limit = self.left();
        if limit.is_zero() {
            return Ran::TimedOut(Duration::ZERO);
        }
        let n = self.count.get() + 1;
        self.count.set(n);
        let (out, err) = (
            self.dir.join(format!("{n}-{program}.out")),
            self.dir.join(format!("{n}-{program}.err")),
        );
        let child = std::fs::create_dir_all(&self.dir)
            .and_then(|()| Ok((File::create(&out)?, File::create(&err)?)))
            .map_err(|e| Spawn::Other(e.to_string()))
            .and_then(|(o, e)| self.spawn(cwd, program, args, o, e));
        let child = match child {
            Ok(c) => c,
            Err(Spawn::Missing) => return Ran::Missing,
            Err(Spawn::Other(e)) => return Ran::Broken(e),
        };
        wait(child, limit, &out, &err)
    }

    fn spawn(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        out: File,
        err: File,
    ) -> Result<Child, Spawn> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .env("CARGO_TERM_COLOR", "never")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err);
        if let Some(p) = &self.path {
            cmd.env("PATH", p);
        }
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Spawn::Missing
            } else {
                Spawn::Other(format!("{program} could not start: {e}"))
            }
        })
    }
}

/// Why a tool did not start.
enum Spawn {
    Missing,
    Other(String),
}

/// Waits for `child` at most `limit`, killing its group past it; its output read from the files.
fn wait(mut child: Child, limit: Duration, out: &Path, err: &Path) -> Ran {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let read = |p: &Path| std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned());
                return match (read(out), read(err)) {
                    (Ok(out), Ok(err)) => Ran::Exited {
                        ok: status.success(),
                        out,
                        err,
                    },
                    (Err(e), _) | (_, Err(e)) => Ran::Broken(format!("reading its output: {e}")),
                };
            }
            Ok(None) if start.elapsed() >= limit => {
                kill(&mut child);
                return Ran::TimedOut(start.elapsed());
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => return Ran::Broken(e.to_string()),
        }
    }
}

/// Kills `child` and every process of its group, then reaps it.
fn kill(child: &mut Child) {
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
