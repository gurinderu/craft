//! The code graph's numbers for the functions a change touches, read by the binary itself from its
//! own index (realm @nick/craft, node #529), so the metrics lenses and their verifier judge from a
//! table in their prompt and need none of the graph's MCP tools — which a task agent may not have.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{GraphError, RECHECK, Ready};
use crate::gate::lines::Lines;

/// How many changed files' functions are read.
const FILES_MAX: usize = 40;

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

/// The numbers of every function whose span holds a changed line of `changed`, file by file within
/// the graph's budget; a file the index left out, one past [`FILES_MAX`] or one whose question
/// failed after the first is named as unread.
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
            Ok((fns, cut)) => {
                if cut {
                    out.unread.push(format!(
                        "{file} (its functions cut at {})",
                        crate::consumers::cbm::ROWS_PER_FILE
                    ));
                }
                let hit = fns.into_iter().filter(|f| touches(f.start, f.end, ranges));
                out.measured.extend(hit.map(|f| Measured {
                    function: f.name,
                    file: file.to_owned(),
                    start: f.start,
                    end: f.end,
                    metrics: f.metrics,
                }));
            }
            Err(why) if asked == 1 => return Err(why.into()),
            Err(why) => out.unread.push(format!("{file} ({why})")),
        }
    }
    let after = r.cbm.index(&r.project, r.deadline)?;
    if (&after.at, &after.root) != (&r.index.at, &r.index.root) {
        return Err(GraphError::Moved {
            project: r.project.clone(),
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
