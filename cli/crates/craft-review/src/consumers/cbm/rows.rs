//! One `query_graph` question for a symbol's callers and its rows read as [`Caller`]s.

use std::time::Instant;

use serde_json::{Value, json};

use super::query::{self, Callers};
use super::{Caller, Cbm, CbmError};

/// One query's callers, whether more were there, and how many rows did not read as a caller.
pub(super) struct Rows {
    pub(super) rows: Vec<Caller>,
    pub(super) cut: bool,
    pub(super) unreadable: usize,
}

impl Cbm {
    /// Up to `max` caller rows of one query, and whether more were there; refused past
    /// `deadline`, each question's time held to what is left until it. An answer with no rows
    /// is refused, not read as no callers.
    pub(super) fn rows(
        &self,
        project: &str,
        name: &str,
        file: &str,
        which: Callers,
        max: usize,
        deadline: Instant,
    ) -> Result<Rows, CbmError> {
        let left = super::left(deadline)?;
        // When what is left is the shorter limit, a question that runs out of it ran out of the
        // budget.
        let budget_bound = left <= self.timeout;
        let query = query::callers(name, file, which, max + 1);
        let args = json!({"project": project, "query": query, "max_rows": max});
        let answer = self
            .call("query_graph", args, left.min(self.timeout))
            .map_err(|e| match e {
                CbmError::Timeout(_) if budget_bound => CbmError::TimeBound,
                e @ (CbmError::Spawn(_)
                | CbmError::Timeout(_)
                | CbmError::TimeBound
                | CbmError::Stopped
                | CbmError::Locked { .. }
                | CbmError::StillIndexing(_)
                | CbmError::Output(_)
                | CbmError::Graph(_)) => e,
            })?;
        let raw = answer
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| CbmError::Graph("query_graph: its answer holds no rows".into()))?;
        let rows: Vec<Caller> = raw.iter().filter_map(caller).collect();
        let unreadable = raw.len() - rows.len();
        let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
        let cut = flag("has_more") || flag("truncated") || raw.len() > max;
        Ok(Rows {
            rows: rows.into_iter().take(max).collect(),
            cut,
            unreadable,
        })
    }
}

/// One `query_graph` row as a [`Caller`]; the graph prints numbers as strings, and an edge with no
/// call line leaves its cell empty.
fn caller(row: &Value) -> Option<Caller> {
    let cell = |i: usize| row.get(i);
    let num = |i: usize| -> Option<u32> {
        let v = cell(i)?;
        v.as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .or_else(|| v.as_str()?.parse().ok())
    };
    Some(Caller {
        symbol: cell(0)?.as_str()?.to_owned(),
        defined_in: cell(1)?.as_str()?.to_owned(),
        file: cell(2)?.as_str()?.to_owned(),
        start: num(3)?,
        end: num(4)?,
        line: num(5),
    })
}
