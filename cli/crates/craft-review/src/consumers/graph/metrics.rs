//! The code graph's numbers for the functions a change touches, read by the binary itself from its
//! own index (realm @nick/craft, node #529), so the metrics lenses and their verifier judge from a
//! table in their prompt and need none of the graph's MCP tools — which a task agent may not have.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{GraphError, RECHECK, Ready};
use crate::consumers::cbm::{CbmError, Functions};
use crate::gate::lines::Lines;

/// How many changed files' functions are read.
const FILES_MAX: usize = 40;

/// The share of the graph's budget the callers leave to the metrics read, however long they take.
const METRICS_FLOOR: Duration = Duration::from_secs(20);

/// What of the graph's budget the callers leave to the metrics read: [`METRICS_FLOOR`] when a
/// metrics lens wants the numbers, nothing otherwise.
pub(in crate::consumers) fn kept_for_metrics(metrics: bool) -> Duration {
    if metrics {
        METRICS_FLOOR
    } else {
        Duration::ZERO
    }
}

/// One function the change touches and the graph's numbers for it, under the graph's own names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Measured {
    pub function: String,
    pub file: String,
    pub start: u32,
    pub end: u32,
    pub metrics: Map<String, Value>,
}

/// What reading the numbers came to: the functions measured, the changed files whose functions
/// were not wholly read, each with why (`file (why)`), and the files the graph answered no function
/// for — one without functions, or a name it does not hold: the two cannot be told apart (realm
/// @nick/craft, node #613).
#[derive(Debug, Default)]
pub(in crate::consumers) struct Read {
    pub(in crate::consumers) measured: Vec<Measured>,
    pub(in crate::consumers) unread: Vec<String>,
    pub(in crate::consumers) empty: Vec<String>,
}

/// The question the metrics read asks, as an error about it names it.
const ASKED: &str = "the numbers of the functions the change touches were read";

/// Whether the span `start..=end` holds a line of `ranges`.
fn touches(start: u32, end: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|&(a, b)| a <= end && start <= b)
}

/// Why a file the graph answered reads as not wholly read, every reason joined: its functions
/// cut, rows that did not read, metric cells that did not read, metric columns the answer did not
/// name (realm @nick/craft, node #613); `None` when it was read whole.
fn unread_why(fns: &Functions) -> Option<String> {
    let mut why = Vec::new();
    if fns.cut {
        why.push(format!(
            "its functions cut at {}",
            crate::consumers::cbm::ROWS_PER_FILE
        ));
    }
    if fns.unreadable > 0 {
        why.push(format!(
            "{} of its rows did not read as a function",
            fns.unreadable
        ));
    }
    if fns.odd > 0 {
        why.push(format!(
            "{} of its rows hold a metric that did not read",
            fns.odd
        ));
    }
    if !fns.missing.is_empty() {
        why.push(format!(
            "the graph's answer names no column f.{}",
            fns.missing.join(", f.")
        ));
    }
    (!why.is_empty()).then(|| why.join("; "))
}

/// A question's error as the read names it: the budget spent, said as such.
fn budget_said(why: CbmError) -> GraphError {
    if matches!(why, CbmError::TimeBound) {
        GraphError::Spent { what: ASKED }
    } else {
        why.into()
    }
}

/// The numbers of every function whose span holds a changed line of `changed`, file by file within
/// the graph's budget; a file the index left out, one past [`FILES_MAX`], one whose question
/// failed after the first or one [`unread_why`] names is named as unread, one the graph answered
/// no function for as empty.
///
/// # Errors
/// When the first question gets no answer, or the index moved while they were asked (node #533).
pub(in crate::consumers) fn graph_metrics(r: &Ready, changed: &Lines) -> Result<Read, GraphError> {
    let mut out = Read::default();
    let until = r.deadline.checked_sub(RECHECK).unwrap_or(r.deadline);
    let mut asked = 0;
    for (file, ranges) in changed.ranges() {
        if crate::coverage::is_inert(file) || ranges.is_empty() {
            continue;
        }
        let skip = if r.index.leaves_out(file) {
            Some("not indexed by the graph".to_owned())
        } else if asked == FILES_MAX {
            Some(format!("past the {FILES_MAX}-file limit"))
        } else {
            None
        };
        if let Some(why) = skip {
            out.unread.push(format!("{file} ({why})"));
            continue;
        }
        asked += 1;
        match r.cbm.functions(&r.project, file, until) {
            Ok(fns) => take(&mut out, file, ranges, fns),
            Err(why) if asked == 1 => return Err(budget_said(why)),
            Err(why) => out.unread.push(format!("{file} ({})", budget_said(why))),
        }
    }
    let after = r.cbm.index(&r.project, r.deadline).map_err(budget_said)?;
    if (&after.at, &after.root) != (&r.index.at, &r.index.root) {
        return Err(GraphError::Moved {
            project: r.project.clone(),
            during: ASKED,
        });
    }
    Ok(out)
}

/// `fns`, the answer for `file`, into `out`: its touched functions measured, the file named
/// unread when it was not read whole, or empty when it answered none.
fn take(out: &mut Read, file: &str, ranges: &[(u32, u32)], fns: Functions) {
    if let Some(why) = unread_why(&fns) {
        out.unread.push(format!("{file} ({why})"));
    } else if fns.read.is_empty() {
        out.empty.push(file.to_owned());
    }
    let hit = fns
        .read
        .into_iter()
        .filter(|f| touches(f.start, f.end, ranges));
    out.measured.extend(hit.map(|f| Measured {
        function: f.name,
        file: file.to_owned(),
        start: f.start,
        end: f.end,
        metrics: f.metrics,
    }));
}

#[cfg(test)]
mod tests {
    use super::touches;

    #[test]
    fn a_function_is_touched_when_its_span_holds_a_changed_line() {
        assert!(touches(10, 20, &[(20, 25)]));
        assert!(touches(10, 20, &[(1, 3), (12, 12)]));
        assert!(!touches(10, 20, &[(1, 9), (21, 30)]));
    }
}
