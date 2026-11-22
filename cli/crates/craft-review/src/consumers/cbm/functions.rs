//! One `query_graph` question for the complexity numbers the graph holds for each function of one
//! file, read as they are: the counts as numbers, the flags as true or false.

use std::time::Instant;

use serde_json::{Map, Value, json};

use super::{Cbm, CbmError, query};
use crate::complexity::{COUNTS, FLAGS};

/// How many functions of one file are read.
pub(crate) const ROWS_PER_FILE: usize = 500;

/// A function of a file, its line span and the graph's numbers for it, under the graph's names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Function {
    pub name: String,
    pub start: u32,
    pub end: u32,
    pub metrics: Map<String, Value>,
}

/// The query for up to `limit` functions of the file `quoted` (a quoted path) that carry metrics.
fn functions_query(quoted: &str, limit: usize) -> String {
    let cols: Vec<String> = COUNTS
        .iter()
        .chain(FLAGS.iter())
        .map(|m| format!("f.{m}"))
        .collect();
    format!(
        "MATCH (f) WHERE f.file_path = {quoted} AND f.cognitive IS NOT NULL RETURN f.name, \
         f.start_line, f.end_line, {} LIMIT {limit}",
        cols.join(", ")
    )
}

impl Cbm {
    /// The functions of `file` the graph holds numbers for, and whether there were more than it
    /// read; refused past `deadline`, or when the path cannot be quoted.
    ///
    /// # Errors
    /// When the graph gives no answer that holds rows.
    pub fn functions(
        &self,
        project: &str,
        file: &str,
        deadline: Instant,
    ) -> Result<(Vec<Function>, bool), CbmError> {
        let left = super::left(deadline)?;
        let quoted = query::quoted(file)
            .ok_or_else(|| CbmError::Graph("its path cannot be quoted".into()))?;
        let query = functions_query(&quoted, ROWS_PER_FILE + 1);
        let args = json!({"project": project, "query": query, "max_rows": ROWS_PER_FILE});
        let answer = self.call("query_graph", args, left.min(self.timeout))?;
        let raw = answer
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| CbmError::Graph("query_graph: its answer holds no rows".into()))?;
        let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
        let cut = flag("has_more") || flag("truncated") || raw.len() > ROWS_PER_FILE;
        let read = raw.iter().filter_map(function).take(ROWS_PER_FILE);
        Ok((read.collect(), cut))
    }
}

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

/// One row as a [`Function`]; a cell that does not read leaves its metric out.
fn function(row: &Value) -> Option<Function> {
    let cell = |i: usize| row.get(i);
    let line = |i: usize| cell(i).and_then(number).and_then(|n| u32::try_from(n).ok());
    let mut metrics = Map::new();
    for (i, m) in COUNTS.iter().enumerate() {
        if let Some(n) = cell(3 + i).and_then(number) {
            metrics.insert((*m).to_owned(), json!(n));
        }
    }
    for (i, m) in FLAGS.iter().enumerate() {
        if let Some(b) = cell(3 + COUNTS.len() + i).and_then(flag) {
            metrics.insert((*m).to_owned(), json!(b));
        }
    }
    Some(Function {
        name: cell(0)?.as_str()?.to_owned(),
        start: line(1)?,
        end: line(2)?,
        metrics,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::function;

    #[test]
    fn a_row_reads_its_counts_as_numbers_and_its_flags_in_either_spelling() {
        let row = json!([
            "sync", "964", "1014", "24", "11", "0", "2", "4", "0", "1", "false", "true"
        ]);
        let f = function(&row).unwrap();
        assert_eq!((f.name.as_str(), f.start, f.end), ("sync", 964, 1014));
        assert_eq!(
            serde_json::Value::Object(f.metrics),
            json!({"cognitive": 24, "complexity": 11, "loop_depth": 0, "transitive_loop_depth": 2,
                "param_count": 4, "linear_scan_in_loop": false, "alloc_in_loop": true,
                "recursion_in_loop": false, "unguarded_recursion": true})
        );
        let odd = function(&json!(["f", "1", "2", "x", null])).unwrap();
        assert!(
            odd.metrics.is_empty(),
            "a cell that does not read is left out"
        );
        assert!(function(&json!(["f", "one", "2"])).is_none());
    }
}
