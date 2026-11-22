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
pub(in crate::consumers) const METRICS_FLOOR: Duration = Duration::from_secs(20);

/// One function the change touches and the graph's numbers for it, under the graph's own names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Measured {
    pub function: String,
    pub file: String,
    pub start: u32,
    pub end: u32,
    pub metrics: Map<String, Value>,
}

/// What reading the numbers came to: the functions measured, and the changed files whose
/// functions were not read, each with why (`file (why)`).
#[derive(Debug, Default)]
pub(in crate::consumers) struct Read {
    pub(in crate::consumers) measured: Vec<Measured>,
    pub(in crate::consumers) unread: Vec<String>,
}

/// Whether the span `start..=end` holds a line of `ranges`.
fn touches(start: u32, end: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|&(a, b)| a <= end && start <= b)
}

/// Why a file the graph indexes reads as not wholly read, each reason: its functions cut, rows
/// that did not read, metric columns the answer did not name, or no function at all — a name the
/// graph does not hold answers no rows, as no function does, so an empty answer is not taken for a
/// file without functions (realm @nick/craft, node #613).
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
    if !fns.missing.is_empty() {
        let cols: Vec<String> = fns.missing.iter().map(|m| format!("f.{m}")).collect();
        why.push(format!(
            "the graph's answer names no column {}",
            cols.join(", ")
        ));
    }
    if fns.read.is_empty() && fns.unreadable == 0 {
        why.push("the graph gave no function of it numbers: none there, or none read".into());
    }
    (!why.is_empty()).then(|| why.join("; "))
}

/// The numbers of every function whose span holds a changed line of `changed`, file by file within
/// the graph's budget; a file the index left out, one past [`FILES_MAX`], one whose question
/// failed after the first or one [`unread_why`] names is named as unread.
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
        if r.index.leaves_out(file) {
            out.unread
                .push(format!("{file} (not indexed by the graph)"));
            continue;
        }
        if asked == FILES_MAX {
            out.unread
                .push(format!("{file} (past the {FILES_MAX}-file limit)"));
            continue;
        }
        asked += 1;
        match r.cbm.functions(&r.project, file, until) {
            Ok(fns) => {
                if let Some(why) = unread_why(&fns) {
                    out.unread.push(format!("{file} ({why})"));
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
            Err(CbmError::TimeBound) if asked == 1 => {
                return Err(GraphError::Spent {
                    what: "the numbers of the functions the change touches were read",
                });
            }
            Err(why) if asked == 1 => return Err(why.into()),
            Err(why) => out.unread.push(format!("{file} ({why})")),
        }
    }
    let after = r.cbm.index(&r.project, r.deadline)?;
    if (&after.at, &after.root) != (&r.index.at, &r.index.root) {
        return Err(GraphError::Moved {
            project: r.project.clone(),
            during: "the numbers of the functions the change touches were read",
        });
    }
    Ok(out)
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
