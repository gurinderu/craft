//! What the writer reads off git, as `integrations/shared/craft-log-run.mjs` and `integrations/shared/repo-key.mjs` read it: one
//! probe at a time, its trimmed stdout, `""` when git fails or is missing — a field that cannot be
//! resolved is empty and never fails a write. Unlike the JavaScript, each probe is bounded: one that
//! outlives [`BOUND`] is killed, reads as `""`, and is kept for the record to name (`gitTimedOut`).

use std::cell::RefCell;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long one git probe may take.
pub const BOUND: Duration = Duration::from_secs(10);

/// What one bounded probe came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// It exited 0: its trimmed stdout.
    Said(String),
    /// It could not run, or exited non-zero.
    Failed,
    /// It outlived its bound and was killed.
    TimedOut,
}

/// `program args` in `cwd`, killed past `limit`; its stdout read as it runs, so a long one cannot
/// fill the pipe and stall.
#[must_use]
pub fn bounded(program: &str, args: &[&str], cwd: &Path, limit: Duration) -> Probe {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let Ok(mut child) = cmd.spawn() else {
        return Probe::Failed;
    };
    let mut pipe = child.stdout.take();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(p) = pipe.as_mut() {
            drop(p.read_to_end(&mut out));
        }
        drop(send.send(out));
    });
    let deadline = Instant::now() + limit;
    let mut status = None;
    loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(s) => status = s,
                Err(_) => break Probe::Failed,
            }
        }
        if let Some(s) = status
            && let Ok(out) = receive.try_recv()
        {
            break if s.success() {
                Probe::Said(String::from_utf8_lossy(&out).trim().to_owned())
            } else {
                Probe::Failed
            };
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            if let Ok(pid) = i32::try_from(child.id())
                && nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                )
                .is_err()
            {}
            drop(child.kill());
            drop(child.wait());
            break Probe::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

thread_local! {
    static TIMED_OUT: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Keeps a git probe that timed out, for the record being written to name.
pub fn note_timed_out(args: &[&str]) {
    TIMED_OUT.with(|t| t.borrow_mut().push(format!("git {}", args.join(" "))));
}

/// The git probes that timed out on this thread since the last [`take_timed_out`], each once.
#[must_use]
pub fn timed_out() -> Vec<String> {
    TIMED_OUT.with(|t| {
        let mut seen: Vec<String> = Vec::new();
        for p in t.borrow().iter() {
            if !seen.contains(p) {
                seen.push(p.clone());
            }
        }
        seen
    })
}

/// [`timed_out`], forgotten after.
#[must_use]
pub fn take_timed_out() -> Vec<String> {
    TIMED_OUT.with(|t| std::mem::take(&mut *t.borrow_mut()))
}

/// git's trimmed stdout for `args` in `cwd`, `""` when it fails or outlives [`BOUND`].
#[must_use]
pub fn git(args: &[&str], cwd: &Path) -> String {
    match bounded("git", args, cwd, BOUND) {
        Probe::Said(out) => out,
        Probe::Failed => String::new(),
        Probe::TimedOut => {
            note_timed_out(args);
            String::new()
        }
    }
}

/// The run's branch and head in the working copy `dir`: no branch on a detached `HEAD`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitId {
    pub branch: String,
    pub head: String,
}

/// `gitIdentity`.
#[must_use]
pub fn identity(dir: &Path) -> GitId {
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"], dir);
    GitId {
        branch: if branch == "HEAD" {
            String::new()
        } else {
            branch
        },
        head: git(&["rev-parse", "HEAD"], dir),
    }
}

/// The repository as the store keys it (`repoKey`): the parent of a common git directory named
/// `.git` (a checkout and its linked worktrees share it), else the work tree's top level, else the
/// common directory, else the real path, else the path as given.
#[must_use]
pub fn repo_key(dir: &Path) -> PathBuf {
    let abs = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let common = git(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &abs,
    );
    let valid = !common.is_empty() && !common.contains('\n') && Path::new(&common).is_absolute();
    if valid
        && (common.ends_with("/.git") || common == ".git")
        && let Some(parent) = Path::new(&common).parent()
    {
        return lexical(parent);
    }
    let top = git(&["rev-parse", "--show-toplevel"], &abs);
    if !top.is_empty() {
        return lexical(Path::new(&top));
    }
    if valid {
        return lexical(Path::new(&common));
    }
    std::fs::canonicalize(&abs).unwrap_or(abs)
}

/// `path.resolve` of an absolute path: `.` and `..` applied, no symlink followed.
#[must_use]
pub fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c @ (std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::Normal(_)) => out.push(c),
        }
    }
    out
}

/// `head` abbreviated as git abbreviates it in the repository at `git_dir`, `""` when it cannot.
#[must_use]
pub fn short_commit(git_dir: &Path, head: &str) -> String {
    let dir = git_dir.display().to_string();
    git(
        &["--git-dir", &dir, "rev-parse", "--short", head],
        Path::new("/"),
    )
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_descendant_holding_stdout_does_not_defeat_the_deadline() {
        let began = Instant::now();
        let got = bounded(
            "sh",
            &["-c", "sleep 2 & exit 0"],
            Path::new("/"),
            Duration::from_millis(100),
        );
        assert_eq!(got, Probe::TimedOut);
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_probe_that_outlives_its_bound_is_killed_and_said_timed_out() {
        let began = Instant::now();
        let got = bounded("sleep", &["5"], Path::new("/"), Duration::from_millis(200));
        assert_eq!(got, Probe::TimedOut);
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "killed, not waited out"
        );
        let said = bounded("printf", &["  x\n"], Path::new("/"), Duration::from_secs(5));
        assert_eq!(said, Probe::Said("x".into()));
        assert_eq!(
            bounded("false", &[], Path::new("/"), Duration::from_secs(5)),
            Probe::Failed
        );
    }

    #[test]
    fn a_git_probe_that_timed_out_is_kept_for_the_record_to_name() {
        drop(take_timed_out());
        note_timed_out(&["status", "--porcelain"]);
        assert_eq!(timed_out(), ["git status --porcelain"]);
        assert_eq!(take_timed_out(), ["git status --porcelain"]);
        assert!(timed_out().is_empty());
    }
}
