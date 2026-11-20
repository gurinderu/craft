//! A command run with a time limit, so the hook answers inside the harness's own: past it the
//! command is killed, with its process group, and the hook says so.

use std::io::{ErrorKind, Read};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// `cmd`'s output, its stdin closed; why not, when it cannot start or outlives `limit`.
pub fn output(mut cmd: Command, limit: Duration) -> Result<Output, String> {
    let name = cmd.get_program().to_string_lossy().into_owned();
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            format!("{name} is not found on PATH")
        } else {
            format!("{name} could not start ({e})")
        }
    })?;
    // Read apart from the wait, so a full pipe never holds the command past its limit; each
    // reader answers on a channel, so one a leftover child keeps open is waited for no longer.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                p.read_to_end(&mut buf).unwrap_or_default();
            }
            // The waiter gave up on it: nobody to answer.
            tx.send(buf).unwrap_or(());
        });
        rx
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                // With its group: what a detached command started goes too.
                craft_review::cancel::kill_group(&mut child);
                // The readers are left behind: a grandchild may still hold the pipes.
                return Err(format!(
                    "{name} did not answer within {} ms",
                    limit.as_millis()
                ));
            }
            Err(e) => return Err(format!("{name} could not be waited for ({e})")),
        }
    };
    // A child the command left may still hold the pipes: read until the same limit, no longer.
    let read = |rx: &mpsc::Receiver<Vec<u8>>| {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|e: mpsc::RecvTimeoutError| {
                format!(
                    "{name} did not answer within {} ms ({e})",
                    limit.as_millis()
                )
            })
    };
    match (read(&out), read(&err)) {
        (Ok(stdout), Ok(stderr)) => Ok(Output {
            status,
            stdout,
            stderr,
        }),
        (Err(why), _) | (_, Err(why)) => {
            // Past the limit with what is left of a detached command's group, as above.
            craft_review::cancel::kill_group(&mut child);
            Err(why)
        }
    }
}

#[cfg(test)]
#[path = "bounded_tests.rs"]
mod tests;
