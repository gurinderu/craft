//! One answer row of the metrics question read as a function, cell by cell by its column.

use serde_json::{Map, Value, json};

use super::Function;
use crate::complexity::{COUNTS, FLAGS};

/// A cell as a number: the graph prints numbers as strings.
fn number(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())
}

/// A cell as a flag: the graph prints one as `true`/`false` or as `1`/`0`.
fn flag(v: &Value) -> Option<bool> {
    if let Some(b) = v.as_bool() {
        return Some(b);
    }
    if let Some(n) = v.as_u64() {
        return Some(n != 0);
    }
    match v.as_str()?.trim() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// Whether `row` reads as a function yet holds a metric cell that is there and does not read (the
/// graph prints an absent one as empty).
pub(super) fn odd(row: &Value, at: &dyn Fn(&str) -> Option<usize>) -> bool {
    let there = |v: &&Value| !v.is_null() && v.as_str().is_none_or(|t| !t.trim().is_empty());
    let cell = |p: &str| row.get(at(p)?).filter(there);
    function(row, at).is_some()
        && (COUNTS
            .iter()
            .any(|m| cell(m).is_some_and(|v| number(v).is_none()))
            || FLAGS
                .iter()
                .any(|m| cell(m).is_some_and(|v| flag(v).is_none())))
}

/// One row as a [`Function`], each cell found by the column `at` names for its property; a metric
/// cell that does not read leaves its metric out, a name or a line that does not leaves the row.
pub(super) fn function(row: &Value, at: &dyn Fn(&str) -> Option<usize>) -> Option<Function> {
    let cell = |p: &str| row.get(at(p)?);
    let line = |p: &str| cell(p).and_then(number).and_then(|n| u32::try_from(n).ok());
    let mut metrics = Map::new();
    for m in COUNTS {
        if let Some(n) = cell(m).and_then(number) {
            metrics.insert(m.to_owned(), json!(n));
        }
    }
    for m in FLAGS {
        if let Some(b) = cell(m).and_then(flag) {
            metrics.insert(m.to_owned(), json!(b));
        }
    }
    Some(Function {
        name: cell("name")?.as_str()?.to_owned(),
        start: line("start_line")?,
        end: line("end_line")?,
        metrics,
    })
}
