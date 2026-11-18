//! One run of the graph's program: bounded in time, in its own process group, its output read
//! up to a cap.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use super::CbmError;

/// How much of one stream is read; a stream past it is a failed answer.
const CAP: u64 = 16 << 20;
/// How often the program is checked for having exited.
const POLL: Duration = Duration::from_millis(20);

pub(super) fn last_line(stderr: &str, stdout: &str) -> String {
    let all = format!("{stderr}\n{stdout}");
    let line = all.lines().map(str::trim).rfind(|l| !l.is_empty());
    line.unwrap_or("no message").chars().take(200).collect()
}

/// What one stream came to: its text, or why it could not be read.
type Drained = Result<String, CbmError>;

/// Reads `r` on its own thread, so a long answer never blocks the program on a full pipe: up to
/// [`CAP`] bytes kept, the rest read and dropped, the text sent once the stream closes.
fn drain<R: Read + Send + 'static>(r: R, name: &'static str) -> Receiver<Drained> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut r = r;
        let mut buf = Vec::new();
        let read = (&mut r)
            .take(CAP + 1)
            .read_to_end(&mut buf)
            .and_then(|_| std::io::copy(&mut r, &mut std::io::sink()));
        let text = match read {
            Err(e) => Err(CbmError::Output(format!("{name} unreadable: {e}"))),
            Ok(_) if buf.len() as u64 > CAP => {
                Err(CbmError::Output(format!("{name} over {CAP} bytes")))
            }
            Ok(_) => String::from_utf8(buf)
                .map_err(|e| CbmError::Output(format!("{name} unreadable: {e}"))),
        };
        // The receiver is gone only when `bounded` has returned already.
        tx.send(text).unwrap_or(());
    });
    rx
}

/// A stream's text, waited for until `deadline`; past it the group is killed, which closes it.
fn collect(rx: &Receiver<Drained>, child: &mut Child, deadline: Instant) -> Drained {
    let left = deadline.saturating_duration_since(Instant::now());
    rx.recv_timeout(left).or_else(|_| {
        kill(child);
        rx.recv()
            .map_err(|e| CbmError::Output(format!("its output reader stopped: {e}")))
    })?
}

/// Runs `cmd` with no stdin, in a process group of its own: its success, stdout and stderr. Past
/// `limit` the group is killed: a program still running is [`CbmError::Timeout`]; one that
/// exited while a process it left holds its output gives what it printed.
pub(super) fn bounded(
    mut cmd: Command,
    limit: Duration,
) -> Result<(bool, String, String), CbmError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| {
        CbmError::Spawn(format!(
            "{} could not run: {e}",
            cmd.get_program().display()
        ))
    })?;
    let out = child.stdout.take().map(|p| drain(p, "stdout"));
    let err = child.stderr.take().map(|p| drain(p, "stderr"));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                kill(&mut child);
                return Err(CbmError::Timeout(limit));
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                kill(&mut child);
                return Err(CbmError::Spawn(e.to_string()));
            }
        }
    };
    let mut read = |rx: Option<Receiver<Drained>>| match rx {
        Some(rx) => collect(&rx, &mut child, deadline),
        None => Ok(String::new()),
    };
    let stdout = read(out)?;
    let stderr = read(err)?;
    Ok((status.success(), stdout, stderr))
}

/// Kills `child`'s process group and reaps `child`.
fn kill(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        // The group may be gone already: nothing is left to kill then.
        nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        )
        .unwrap_or(());
    }
    // The leader may be reaped already.
    child.kill().unwrap_or(());
    if child.wait().is_err() {
        // Nothing is left to reap.
    }
}

#[cfg(test)]
mod tests;
