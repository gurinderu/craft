//! One `query_graph` question for the complexity numbers the graph holds for each function of one
//! file, read as they are: the counts as numbers, the flags as true or false. The property names,
//! the unlabelled `MATCH (f)` (a `Function` or a `Method` carries them) and the cells' spelling are
//! codebase-memory-mcp 0.12.1's as observed (realm @nick/craft, node #530); a cell is read by the
//! column the answer names it, never by its place, so a wrong name reads as no cell, not another's.

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

/// What one file's question read: its functions, whether there were more than it read, and how
/// many rows did not read as a function.
#[derive(Debug, Default)]
pub struct Functions {
    pub read: Vec<Function>,
    pub cut: bool,
    pub unreadable: usize,
}

/// The properties the question returns, in order: the name, the span, the counts, the flags.
fn properties() -> impl Iterator<Item = &'static str> {
    ["name", "start_line", "end_line"]
        .into_iter()
        .chain(COUNTS)
        .chain(FLAGS)
}

/// The query for up to `limit` functions of the file `quoted` (a quoted path) that carry metrics.
fn functions_query(quoted: &str, limit: usize) -> String {
    let cols: Vec<String> = properties().map(|m| format!("f.{m}")).collect();
    format!(
        "MATCH (f) WHERE f.file_path = {quoted} AND f.cognitive IS NOT NULL RETURN {} LIMIT {limit}",
        cols.join(", ")
    )
}

impl Cbm {
    /// The functions of `file` the graph holds numbers for; refused past `deadline`, or when the
    /// path cannot be quoted.
    ///
    /// # Errors
    /// When the graph gives no answer that holds rows and names their columns.
    pub fn functions(
        &self,
        project: &str,
        file: &str,
        deadline: Instant,
    ) -> Result<Functions, CbmError> {
        let left = super::left(deadline)?;
        // When what is left is the shorter limit, a question that runs out of it ran out of the
        // budget.
        let budget_bound = left <= self.timeout;
        let quoted = query::quoted(file)
            .ok_or_else(|| CbmError::Graph("its path cannot be quoted".into()))?;
        let query = functions_query(&quoted, ROWS_PER_FILE + 1);
        let args = json!({"project": project, "query": query, "max_rows": ROWS_PER_FILE});
        let answer = self
            .call("query_graph", args, left.min(self.timeout))
            .map_err(|e| super::of_budget(e, budget_bound))?;
        let raw = answer
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| CbmError::Graph("query_graph: its answer holds no rows".into()))?;
        let names: Vec<&str> = answer
            .get("columns")
            .and_then(Value::as_array)
            .map(|c| c.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let at = |p: &str| names.iter().position(|n| n.strip_prefix("f.") == Some(p));
        if let Some(p) = ["name", "start_line", "end_line"]
            .into_iter()
            .find(|p| at(p).is_none())
        {
            return Err(CbmError::Graph(format!(
                "query_graph: its answer names no column `f.{p}`"
            )));
        }
        let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
        let cut = flag("has_more") || flag("truncated") || raw.len() > ROWS_PER_FILE;
        let read: Vec<Function> = raw.iter().filter_map(|r| function(r, &at)).collect();
        Ok(Functions {
            unreadable: raw.len() - read.len(),
            read: read.into_iter().take(ROWS_PER_FILE).collect(),
            cut,
        })
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

/// One row as a [`Function`], each cell found by the column `at` names for its property; a metric
/// cell that does not read leaves its metric out, a name or a line that does not leaves the row.
fn function(row: &Value, at: &dyn Fn(&str) -> Option<usize>) -> Option<Function> {
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{function, functions_query, properties};

    /// The column of property `p` in the question's own RETURN order.
    fn at(p: &str) -> Option<usize> {
        properties().position(|q| q == p)
    }

    #[test]
    fn a_row_reads_its_counts_as_numbers_and_its_flags_in_either_spelling() {
        // As codebase-memory-mcp 0.12.1 answered (realm @nick/craft, node #530).
        let row = json!([
            "sync", "964", "1014", "24", "11", "0", "2", "4", "0", "1", "false", "true"
        ]);
        let f = function(&row, &at).unwrap();
        assert_eq!((f.name.as_str(), f.start, f.end), ("sync", 964, 1014));
        assert_eq!(
            serde_json::Value::Object(f.metrics),
            json!({"cognitive": 24, "complexity": 11, "loop_depth": 0, "transitive_loop_depth": 2,
                "param_count": 4, "linear_scan_in_loop": false, "alloc_in_loop": true,
                "recursion_in_loop": false, "unguarded_recursion": true})
        );
        let odd = function(&json!(["f", "1", "2", "x", null]), &at).unwrap();
        assert!(
            odd.metrics.is_empty(),
            "a cell that does not read is left out"
        );
        assert!(function(&json!(["f", "one", "2"]), &at).is_none());
    }

    #[test]
    fn a_cell_is_read_by_its_column_not_its_place() {
        let swapped = |p: &str| match p {
            "name" => Some(1),
            "start_line" => Some(0),
            "end_line" => Some(2),
            "cognitive" => Some(3),
            _ => None,
        };
        let f = function(&json!(["7", "g", "9", "5"]), &swapped).unwrap();
        assert_eq!((f.name.as_str(), f.start, f.end), ("g", 7, 9));
        assert_eq!(
            serde_json::Value::Object(f.metrics),
            json!({"cognitive": 5})
        );
    }

    #[test]
    fn the_question_returns_each_property_it_reads() {
        let q = functions_query("\"a.rs\"", 3);
        let cols: Vec<String> = properties().map(|p| format!("f.{p}")).collect();
        assert!(
            q.contains(&format!("RETURN {} LIMIT 3", cols.join(", "))),
            "{q}"
        );
    }
}
