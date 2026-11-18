//! One run of the graph's program: bounded in time, its output read whole.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn last_line(stderr: &str, stdout: &str) -> String {
    let all = format!("{stderr}\n{stdout}");
    let line = all.lines().map(str::trim).rfind(|l| !l.is_empty());
    line.unwrap_or("no message").chars().take(200).collect()
}

/// Runs `cmd` with no stdin, its success, stdout and stderr; killed past `limit`. stdout is read
/// on its own thread, so a long answer never blocks the program on a full pipe.
pub(super) fn bounded(mut cmd: Command, limit: Duration) -> Result<(bool, String, String), String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{} could not run: {e}", cmd.get_program().display()))?;
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            r.map(|mut r| r.read_to_string(&mut s));
            s
        })
    };
    let out = pipe(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = pipe(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed() > limit {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            return Err(format!("no answer within {}s", limit.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let read = |h: std::thread::JoinHandle<String>| h.join().unwrap_or_default();
    Ok((status.success(), read(out), read(err)))
}
