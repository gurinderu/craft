//! A command run with a time limit, so the hook answers inside the harness's own: past it the
//! command is killed and the hook says so.

use std::io::{ErrorKind, Read};
use std::process::{Command, Output, Stdio};
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
    // Read apart from the wait, so a full pipe never holds the command past its limit.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                p.read_to_end(&mut buf).unwrap_or_default();
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                child.kill().unwrap_or_default();
                child.wait().map(drop).unwrap_or_default();
                // The readers are left behind: a grandchild may still hold the pipes.
                return Err(format!(
                    "{name} did not answer within {} ms",
                    limit.as_millis()
                ));
            }
            Err(e) => return Err(format!("{name} could not be waited for ({e})")),
        }
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

#[cfg(test)]
#[path = "bounded_tests.rs"]
mod tests;
