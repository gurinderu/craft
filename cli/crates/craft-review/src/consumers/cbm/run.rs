//! One run of the graph's program: bounded in time, stopped with the run, detached in a session
//! of its own, its output in files read once it exits — so nothing it left running holds the read
//! open, and its group is killed only while its leader is unreaped (its pid still its group's).

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::CbmError;
use crate::cancel::{Cancel, detached, kill_group};
use crate::sources::spool::Spool;

/// How much of one stream is read; a stream past it is a failed answer.
const CAP: u64 = 16 << 20;
/// How often the program is checked for having exited.
const POLL: Duration = Duration::from_millis(20);

pub(super) fn last_line(stderr: &str, stdout: &str) -> String {
    let all = format!("{stderr}\n{stdout}");
    let line = all.lines().map(str::trim).rfind(|l| !l.is_empty());
    line.unwrap_or("no message").chars().take(200).collect()
}

/// The payload of the tool `name`'s run that exited `ok` with `stdout` and `stderr`; why not,
/// one line.
pub(super) fn payload(name: &str, ok: bool, stdout: &str, stderr: &str) -> Result<Value, CbmError> {
    let payload: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    let error = payload.as_ref().and_then(|p| p.get("error"));
    match (ok, payload.as_ref(), error) {
        (true, Some(p), None) => Ok(p.clone()),
        (_, _, Some(e)) => Err(CbmError::Graph(format!(
            "{name}: {}",
            e.as_str().map_or_else(|| e.to_string(), str::to_owned)
        ))),
        _ => Err(CbmError::Graph(format!(
            "{name}: {}",
            last_line(stderr, stdout)
        ))),
    }
}

fn kept(name: &str, e: &std::io::Error) -> CbmError {
    CbmError::Output(format!("{name} unreadable: {e}"))
}

/// Runs `cmd` with no stdin, detached: its success, stdout and stderr. Past `limit` its group is
/// killed and the run is [`CbmError::Timeout`]; once `cancel` is, [`CbmError::Stopped`]. A
/// process it left behind past its exit is not waited for: its output is read as it stands.
pub(super) fn bounded(
    mut cmd: Command,
    limit: Duration,
    cancel: &Cancel,
) -> Result<(bool, String, String), CbmError> {
    if cancel.is_cancelled() {
        return Err(CbmError::Stopped);
    }
    let (mut out, to_out) = Spool::new().map_err(|e| kept("stdout", &e))?;
    let (mut err, to_err) = Spool::new().map_err(|e| kept("stderr", &e))?;
    cmd.stdin(Stdio::null()).stdout(to_out).stderr(to_err);
    detached(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        CbmError::Spawn(format!(
            "{} could not run: {e}",
            cmd.get_program().display()
        ))
    })?;
    let deadline = Instant::now() + limit;
    let status = loop {
        // A leader not yet reaped keeps its pid, so the group's kill reaches its own group.
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if cancel.is_cancelled() => {
                kill_group(&mut child);
                return Err(CbmError::Stopped);
            }
            Ok(None) if Instant::now() >= deadline => {
                kill_group(&mut child);
                return Err(CbmError::Timeout(limit));
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                kill_group(&mut child);
                return Err(CbmError::Spawn(format!("waiting on it failed: {e}")));
            }
        }
    };
    let stdout = out.whole(CAP).map_err(|e| kept("stdout", &e))?;
    let stderr = err.whole(CAP).map_err(|e| kept("stderr", &e))?;
    Ok((status.success(), stdout, stderr))
}

#[cfg(test)]
mod tests;
