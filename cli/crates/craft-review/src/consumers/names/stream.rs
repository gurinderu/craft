//! One name search's `git grep`: its stdout read line by line as it comes, stopped once the lines
//! pass [`HITS_MAX`] or the search's deadline passes.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{BUDGET, HITS_MAX, Hit};

/// How much of git's stderr is kept.
const ERR_MAX: u64 = 64 * 1024;

/// How a search's program ended: stopped once its lines passed [`HITS_MAX`], or exited with its
/// code, its lines and its stderr.
pub(super) enum Ended {
    Capped,
    Exited(Option<i32>, Vec<Hit>, String),
}

/// Runs `cmd`, its stdout read line by line as it comes; killed once its lines pass [`HITS_MAX`]
/// or `deadline` passes.
pub(super) fn stream(mut cmd: Command, deadline: Instant) -> Result<Ended, String> {
    if Instant::now() >= deadline {
        return Err(out_of_time());
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git grep could not run: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    let hits = thread::spawn(move || out.map_or(Ok(Vec::new()), read_hits));
    let stderr = thread::spawn(move || {
        let mut s = String::new();
        err.map(|e| e.take(ERR_MAX).read_to_string(&mut s));
        s
    });
    if let Err(e) = until(deadline, || Ok(hits.is_finished())) {
        kill(&mut child);
        return Err(e);
    }
    let hits = hits
        .join()
        .map_err(|p| format!("git grep's reader panicked: {p:?}"))??;
    if hits.len() > HITS_MAX {
        kill(&mut child);
        return Ok(Ended::Capped);
    }
    let mut code = None;
    let reaped = until(deadline, || {
        code = child
            .try_wait()
            .map_err(|e| e.to_string())?
            .map(|s| s.code());
        Ok(code.is_some())
    });
    if let Err(e) = reaped {
        kill(&mut child);
        return Err(e);
    }
    Ok(Ended::Exited(
        code.flatten(),
        hits,
        stderr.join().unwrap_or_default(),
    ))
}

/// Waits until `done`, or `Err` once `deadline` passes.
fn until(deadline: Instant, mut done: impl FnMut() -> Result<bool, String>) -> Result<(), String> {
    while !done()? {
        if Instant::now() >= deadline {
            return Err(out_of_time());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn kill(child: &mut Child) {
    // An Err means it already exited: nothing is left to stop, and the wait reaps it either way.
    let _killed = child.kill().is_ok();
    let _reaped = child.wait().is_ok();
}

pub(super) fn out_of_time() -> String {
    format!("no time left of the name search's {}s", BUDGET.as_secs())
}

/// The hits of `git grep -z -n`'s stdout, read until it closes or one past [`HITS_MAX`].
fn read_hits(out: impl Read) -> Result<Vec<Hit>, String> {
    let mut hits = Vec::new();
    for line in BufReader::new(out).split(b'\n') {
        let line = line.map_err(|e| format!("git grep's output unreadable: {e}"))?;
        hits.extend(hit(&String::from_utf8_lossy(&line)));
        if hits.len() > HITS_MAX {
            break;
        }
    }
    Ok(hits)
}

/// One `path\0line\0text` line of `git grep -z -n`.
fn hit(l: &str) -> Option<Hit> {
    let mut parts = l.splitn(3, '\0');
    let file = parts.next()?.to_owned();
    let line = parts.next()?.parse().ok()?;
    let text = parts.next()?.to_owned();
    Some(Hit { file, line, text })
}
