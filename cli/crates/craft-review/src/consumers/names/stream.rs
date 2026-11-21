//! One name search's `git grep`: its stdout read line by line as it comes, stopped once the lines
//! pass [`HITS_MAX`] or the search's deadline passes.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{BUDGET, HITS_MAX, Hit};
use crate::cancel::{Cancel, STOPPED};

/// How much of git's stderr is kept.
const ERR_MAX: u64 = 64 * 1024;

/// How a search's program ended: stopped once its records passed their most, or exited with its
/// code, its lines and its stderr.
pub(super) enum Ended {
    Capped,
    Exited(Option<i32>, Vec<Hit>, String),
}

/// How a program's stdout is read: what ends one record, how a record becomes a hit, and how many
/// it may give before it is stopped.
#[derive(Clone, Copy)]
pub(super) struct Format {
    pub sep: u8,
    pub parse: fn(&str) -> Option<Hit>,
    pub max: usize,
}

/// `git grep -z -n`'s lines, up to [`HITS_MAX`].
const LINES: Format = Format {
    sep: b'\n',
    parse: hit,
    max: HITS_MAX,
};

/// Runs `cmd`, its stdout read line by line as it comes; killed once its lines pass [`HITS_MAX`],
/// `deadline` passes or `cancel` is.
pub(super) fn stream(cmd: Command, deadline: Instant, cancel: &Cancel) -> Result<Ended, String> {
    stream_as(cmd, LINES, deadline, cancel)
}

/// [`stream`], its stdout read as `format` says.
pub(super) fn stream_as(
    mut cmd: Command,
    format: Format,
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Ended, String> {
    if cancel.is_cancelled() {
        return Err(STOPPED.into());
    }
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
    let hits = thread::spawn(move || out.map_or(Ok(Vec::new()), |o| read_hits(o, format)));
    let stderr = thread::spawn(move || {
        let mut s = String::new();
        err.map(|e| e.take(ERR_MAX).read_to_string(&mut s));
        s
    });
    if let Err(e) = until((deadline, cancel), || Ok(hits.is_finished())) {
        kill(&mut child);
        return Err(e);
    }
    let hits = hits
        .join()
        .map_err(|p| format!("git grep's reader panicked: {p:?}"))??;
    if hits.len() > format.max {
        kill(&mut child);
        return Ok(Ended::Capped);
    }
    let mut code = None;
    let reaped = until((deadline, cancel), || {
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

/// Waits until `done`, or `Err` once `deadline` passes or `cancel` is.
fn until(
    (deadline, cancel): (Instant, &Cancel),
    mut done: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    while !done()? {
        if cancel.is_cancelled() {
            return Err(STOPPED.into());
        }
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

/// The hits of a program's stdout read as `format` says, until it closes or one past its most.
fn read_hits(out: impl Read, format: Format) -> Result<Vec<Hit>, String> {
    let mut hits = Vec::new();
    for line in BufReader::new(out).split(format.sep) {
        let line = line.map_err(|e| format!("git grep's output unreadable: {e}"))?;
        // As `str::lines`: a CRLF file's line ends without its `\r`.
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        hits.extend((format.parse)(&String::from_utf8_lossy(line)));
        if hits.len() > format.max {
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
