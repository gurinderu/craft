//! The hook log read: both generations, oldest first, each line as the report reads it; a line
//! that does not read is counted.

use std::path::Path;

use craft_store::js::{Js, Obj, parse};

use crate::hook::role::iso;

/// One line of the log, as the report reads it.
#[derive(Debug, Clone)]
pub(super) struct Line {
    pub(super) event: String,
    pub(super) reason: String,
    pub(super) harness: String,
    pub(super) repo: String,
    pub(super) spoke: bool,
    pub(super) silent: String,
    pub(super) ts: Option<i64>,
}

/// The events only the `OpenCode` work hook writes.
const OPENCODE_EVENTS: [&str; 2] = ["chat.message", "session.compacted"];

fn text(o: &Obj, k: &str) -> String {
    o.get(k).and_then(Js::as_str).unwrap_or("").to_owned()
}

/// A log time, ISO or a run record's stamp (`T15-14-29Z`), in milliseconds.
pub(crate) fn millis(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    let stamp = b.len() >= 19
        && b.get(10) == Some(&b'T')
        && b.get(13) == Some(&b'-')
        && b.get(16) == Some(&b'-');
    if stamp {
        let fixed = format!("{}:{}:{}", ts.get(..13)?, ts.get(14..16)?, ts.get(17..)?);
        return iso::parse(&fixed);
    }
    iso::parse(ts)
}

fn line_of(o: &Obj) -> Option<Line> {
    let repo = o.get("repo").and_then(Js::as_str)?.to_owned();
    let Some(Js::Bool(spoke)) = o.get("spoke") else {
        return None;
    };
    let event = Some(text(o, "event"))
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "SessionStart".into());
    let harness = Some(text(o, "harness"))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| {
            if OPENCODE_EVENTS.contains(&event.as_str()) {
                "opencode"
            } else {
                "claude-code"
            }
            .into()
        });
    let silent = match o.get("silent") {
        Some(Js::Str(s)) => s.to_utf8_lossy(),
        _ => "unknown".into(),
    };
    Some(Line {
        event,
        reason: text(o, "reason"),
        harness,
        repo,
        spoke: *spoke,
        silent,
        ts: o.get("ts").and_then(Js::as_str).and_then(millis),
    })
}

/// Both generations, oldest first, and how many non-blank lines did not read; `None` with neither file.
pub(super) fn read(file: &Path) -> Option<(Vec<Line>, usize)> {
    let mut any = false;
    let (mut out, mut bad) = (Vec::new(), 0);
    let mut older = file.as_os_str().to_owned();
    older.push(".1");
    for f in [Path::new(&older), file] {
        let Ok(bytes) = std::fs::read(f) else {
            continue;
        };
        any = true;
        for l in String::from_utf8_lossy(&bytes)
            .split('\n')
            .filter(|l| !l.trim().is_empty())
        {
            match parse(l)
                .ok()
                .as_ref()
                .and_then(Js::as_obj)
                .and_then(line_of)
            {
                Some(line) => out.push(line),
                None => bad += 1,
            }
        }
    }
    any.then_some((out, bad))
}
