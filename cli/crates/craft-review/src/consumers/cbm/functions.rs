//! One `query_graph` question for the complexity numbers the graph holds for each function of one
//! file, read as they are: the counts as numbers, the flags as true or false. The property names,
//! the unlabelled `MATCH (f)` (a `Function` or a `Method` carries them) and the cells' spelling are
//! codebase-memory-mcp 0.12.1's as observed (realm @nick/craft, node #613); a cell is read by the
//! column the answer names it, never by its place, so a wrong name reads as no cell, not another's.

use std::time::Instant;

use serde_json::{Map, Value, json};

use super::{Cbm, CbmError, query};

mod row;

use crate::complexity::{COUNTS, FLAGS};
use row::{function, odd};

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

/// What one file's question read: its functions, whether there were more than it read, how many
/// rows did not read as a function, how many hold a metric cell that did not read, and the metric
/// columns the answer did not name (each metric then missing from every function).
#[derive(Debug, Default)]
pub struct Functions {
    pub read: Vec<Function>,
    pub cut: bool,
    pub unreadable: usize,
    pub odd: usize,
    pub missing: Vec<&'static str>,
}

/// The properties a row cannot be read without: the name and the span.
const SPAN: [&str; 3] = ["name", "start_line", "end_line"];

/// The metrics the question asks for: the counts, then the flags.
fn metric_names() -> impl Iterator<Item = &'static str> {
    COUNTS.into_iter().chain(FLAGS)
}

/// The properties the question returns, in order: the name, the span, then the metrics.
fn properties() -> impl Iterator<Item = &'static str> {
    SPAN.into_iter().chain(metric_names())
}

/// What makes a node one with numbers: a `Function` or a `Method` carries its cognitive count.
const MEASURED: &str = "f.cognitive IS NOT NULL";

/// The query for up to `limit` functions of the file `quoted` (a quoted path) that carry metrics.
fn functions_query(quoted: &str, limit: usize) -> String {
    let cols: Vec<String> = properties().map(|m| format!("f.{m}")).collect();
    format!(
        "MATCH (f) WHERE f.file_path = {quoted} AND {MEASURED} RETURN {} LIMIT {limit}",
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
        if let Some(p) = SPAN.into_iter().find(|p| at(p).is_none()) {
            return Err(CbmError::Graph(format!(
                "query_graph: its answer names no column `f.{p}`"
            )));
        }
        let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
        let cut = flag("has_more") || flag("truncated") || raw.len() > ROWS_PER_FILE;
        let read: Vec<Function> = raw.iter().filter_map(|r| function(r, &at)).collect();
        Ok(Functions {
            unreadable: raw.len() - read.len(),
            odd: raw.iter().filter(|r| odd(r, &at)).count(),
            read: read.into_iter().take(ROWS_PER_FILE).collect(),
            cut,
            // Columns the answer names, rows or none, are its shape: one it lacks is doubt.
            missing: metric_names().filter(|p| at(p).is_none()).collect(),
        })
    }

    /// Whether the graph holds the numbers of any function of `project`, asked once by
    /// `deadline`: an answer of no rows for every file cannot tell files without functions from a
    /// property the graph no longer names, which answers no rows too (realm @nick/craft, node #613).
    ///
    /// # Errors
    /// When the graph gives no answer that holds rows.
    pub fn holds_numbers(&self, project: &str, deadline: Instant) -> Result<bool, CbmError> {
        let left = super::left(deadline)?;
        let budget_bound = left <= self.timeout;
        let query = format!("MATCH (f) WHERE {MEASURED} RETURN f.name LIMIT 1");
        let args = json!({"project": project, "query": query, "max_rows": 1});
        let answer = self
            .call("query_graph", args, left.min(self.timeout))
            .map_err(|e| super::of_budget(e, budget_bound))?;
        let rows = answer.get("rows").and_then(Value::as_array);
        let rows =
            rows.ok_or_else(|| CbmError::Graph("query_graph: its answer holds no rows".into()))?;
        Ok(!rows.is_empty())
    }
}

#[cfg(test)]
#[path = "functions_tests.rs"]
mod tests;
